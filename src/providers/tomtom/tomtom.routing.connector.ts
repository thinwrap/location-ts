import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { encodePolyline, joinCoords, mergePassthrough } from '../../utils';
import type { TomTomConfig } from './tomtom.config';
import type { TomTomRouteResponse } from './tomtom.types';

const ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute';

/**
 * TomTom Routing v1 connector — per-connector template.
 *
 * GETs `https://api.tomtom.com/routing/1/calculateRoute/{locations}/json` with
 * the API key carried via the `key=` query parameter. `{locations}` is the
 * colon-separated `lat,lng:lat,lng:...` path-coords form unique to TomTom
 * (built via {@link joinCoords} with `'latlng'` + `':'`).
 *
 * Body shape follows the per-connector template:
 *   1. Build vendor query string.
 *   2. {@link mergePassthrough} body / headers / query (4-arg form).
 *   3. Call {@link BaseConnector.sendGet} with merged headers + query.
 *   4. On non-2xx, parse body + raise {@link ConnectorError} via
 *      {@link mapVendorError} with Retry-After surfaced in providerMessage +
 * `cause.retryAfter` by design
 *      (no structured `retryAfterSeconds` field).
 *   5. Normalize 2xx body into the operation result DTO.
 *
 * Travel mode mapping: `driving → car`, `walking → pedestrian`,
 * `cycling → bicycle`. Avoid flags collapse into a comma-joined
 * `avoid=` query value: `avoidTolls → tollRoads`, `avoidFerries → ferries`,
 * `avoidHighways → motorways`.
 *
 * Polyline is rebuilt inline: `routes[0].legs[*].points` arrives as
 * `{ latitude, longitude }` pairs (full-word keys, NOT lat/lng), flattened
 * across all legs and re-encoded to Google precision-5 via
 * {@link encodePolyline}.
 */
export class TomTomRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'tomtom';

  constructor(private config: TomTomConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'TomTom Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'TomTom Routing requires at least two waypoints',
      });
    }

    // TomTom path-coords: `lat,lng:lat,lng:...` (colon-separated).
    const locations = joinCoords(waypoints, 'latlng', ':');
    const url = `${ROUTE_URL}/${locations}/json`;

    const baseQuery: Record<string, string> = {
      key: this.config.apiKey,
      travelMode: mapTravelMode(options.travelMode),
      routeType: 'fastest',
      routeRepresentation: 'polyline',
    };

    if (options.optimize === true && waypoints.length > 2) {
      baseQuery.computeBestOrder = 'true';
    }

    if (options.departureTime) {
      baseQuery.departAt = options.departureTime.toISOString();
    }

    const avoids = buildAvoids(options);
    if (avoids !== '') {
      baseQuery.avoid = avoids;
    }

    // Per-connector body merge: body is empty for this GET. Query carries the
    // vendor params + headers may be augmented by passthrough.
    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomRouteResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'TomTom Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Routing returned a malformed response body',
        cause: data,
      });
    }
    const route = data.routes?.[0];
    if (!route) {
      throw new ConnectorError({
        message: 'TomTom Routing returned no routes',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Routing returned no routes',
        cause: data,
      });
    }

    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.summary?.lengthInMeters ?? 0,
      durationSeconds: leg.summary?.travelTimeInSeconds ?? 0,
    }));

    // Flatten all leg points (TomTom uses { latitude, longitude } full-word
    // keys) into LatLng[] and re-encode to precision-5.
    const allPoints: LatLng[] = (route.legs ?? []).flatMap((leg) =>
      (leg.points ?? []).map((p) => ({ lat: p.latitude, lng: p.longitude })),
    );
    const polyline = encodePolyline(allPoints);

    let waypointOrder: number[] | undefined;
    if (
      options.optimize === true &&
      Array.isArray(data.optimizedWaypoints)
    ) {
      waypointOrder = data.optimizedWaypoints
        .slice()
        .sort((a, b) => a.optimizedIndex - b.optimizedIndex)
        .map((wp) => wp.providedIndex);
    }

    return {
      legs,
      totalDistanceMeters: route.summary?.lengthInMeters ?? 0,
      totalDurationSeconds: route.summary?.travelTimeInSeconds ?? 0,
      polyline,
      ...(waypointOrder !== undefined ? { waypointOrder } : {}),
      raw: data,
    };
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx HTTP
   * responses. Surfaces Retry-After in `providerMessage` and `cause` by design (no structured retry field).
   */
  private async raiseHttpError(response: Response): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null
        ? { ...(errorBody ?? {}), retryAfter }
        : errorBody;
    return new ConnectorError({
      message: `TomTom Routing failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map TomTom (HTTP status, decoded body) → canonical {@link ProviderCode}
   * Classification is purely status-driven per the v1 spec:
   *   - 400 / 404 → `invalid_request` (404 = no route found).
   *   - 401 / 403 → `auth_failed`.
   *   - 429       → `rate_limited`.
   *   - 5xx       → `provider_unavailable`.
   * the mapping lives per-connector (no shared middleware).
   */
  private mapVendorError(
    httpStatus: number,
    _body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400 || httpStatus === 404) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design.
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readTomTomErrorMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
  switch (mode) {
    case 'walking':
      return 'pedestrian';
    case 'cycling':
      return 'bicycle';
    default:
      return 'car';
  }
}

function buildAvoids(options: IRoutingOptions): string {
  const avoids: string[] = [];
  if (options.avoidTolls) avoids.push('tollRoads');
  if (options.avoidFerries) avoids.push('ferries');
  if (options.avoidHighways) avoids.push('motorways');
  return avoids.join(',');
}

function readTomTomErrorMessage(
  body: Record<string, unknown> | null,
): string | null {
  if (body === null) return null;

  // TomTom v1 errors typically arrive as either:
  //   { error: { description: "..." } }
  //   { error: "..." }
  //   { detailedError: { message: "..." } }
  //   { message: "..." }
  const detailed = body.detailedError;
  if (detailed !== null && typeof detailed === 'object') {
    const msg = (detailed as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg !== '') return msg;
  }

  const errorField = body.error;
  if (errorField !== null && typeof errorField === 'object') {
    const errObj = errorField as Record<string, unknown>;
    const description = errObj.description;
    if (typeof description === 'string' && description !== '') return description;
    const message = errObj.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof errorField === 'string' && errorField !== '') return errorField;

  if (typeof body.message === 'string' && body.message !== '') {
    return body.message;
  }

  return null;
}
