import { BaseConnector, type QueryParams } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingLeg,
  IRoutingOptions,
  IRoutingResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  assertRouteHasLegs,
  encodePolyline,
  isCompleteWaypointOrder,
  isFiniteNumber,
  isRecord,
  joinCoords,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
} from '../../utils';
import { validateRoutingOptions } from '../../utils/validate-options';
import { isTrafficRequested } from '../../utils/traffic';
import type { TomTomConfig } from './tomtom.config';
import type { TomTomRouteResponse } from './tomtom.types';

const ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute';

/**
 * TomTom Routing v1 connector.
 *
 * GETs `https://api.tomtom.com/routing/1/calculateRoute/{locations}/json` with
 * the API key carried via the `key=` query parameter. `{locations}` is the
 * colon-separated `lat,lng:lat,lng:...` path-coords form unique to TomTom
 * (built via {@link joinCoords} with `'latlng'` + `':'`).
 *
 * Travel mode mapping: `driving → car`, `walking → pedestrian`,
 * `cycling → bicycle`. Each avoid flag is its own REPEATED `avoid=` query
 * param (`avoidTolls → tollRoads`, `avoidFerries → ferries`,
 * `avoidHighways → motorways`): calculateRoute answers a comma list
 * (`avoid=tollRoads,motorways`) with 400 `Invalid avoid value`.
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
    validateRoutingOptions(options, 'TomTom Routing');
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

    const baseQuery: Record<string, string | string[]> = {
      key: this.config.apiKey,
      travelMode: mapTravelMode(options.travelMode),
      routeType: 'fastest',
      routeRepresentation: 'polyline',
    };

    // TomTom computeBestOrder reorders the intermediate waypoints while keeping the
    // first/last fixed (an OPEN route); it has no closed round-trip mode. Surface
    // the unsupported flag instead of silently returning an open route.
    if (options.isRoundTrip === true) {
      throw new ConnectorError({
        message: 'TomTom route optimization does not support round trips (isRoundTrip)',
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage:
          'TomTom computeBestOrder optimizes an open route (fixed first/last waypoint) and cannot return a closed round trip; remove isRoundTrip or use a provider that supports it (e.g. Mapbox/OSRM).',
      });
    }

    // Any of the three optimize flags means "reorder", as on Google/HERE/Mapbox/
    // OSRM. TomTom always keeps BOTH ends fixed — it has no way to free one — so
    // optimizeFixedOrigin / optimizeFixedDestination alone still reorder only
    // the intermediates.
    const optimize = wantsOptimization(options);
    if (optimize && waypoints.length > 2) {
      baseQuery.computeBestOrder = 'true';
    }

    // Kept under `'none'` too: Calculate Route has no time-independent mode.
    // Its `departAt` has no `any` value here (live: 400 "traffic=false not
    // allowed in combination with departAt=any", and the same with `true`), so
    // dropping the time would only move the departure to now.
    if (options.departureTime) {
      baseQuery.departAt = options.departureTime.toISOString();
    }

    // TomTom's `traffic` parameter defaults to ON at the vendor, so leaving it
    // unset would contradict the normalized default of `trafficMode: 'none'`.
    // Send it explicitly in both directions. `false` is the closest TomTom gets
    // to `'none'`, and it is an approximation: "although the current traffic
    // data is ignored during routing, the effect of historic traffic on
    // effective road speeds is still incorporated" — typical traffic for the
    // departure time (or now) stays in the duration. The README says so.
    baseQuery.traffic = isTrafficRequested(options.trafficMode) ? 'true' : 'false';

    // `noTrafficTravelTimeInSeconds` only appears when `computeTravelTimeFor=all`
    // is requested, and that asks TomTom for extra computed values — so unlike
    // Google/HERE it is a real request change and stays strictly opt-in.
    const wantsNoTrafficTime =
      options.include?.includes('durationWithoutTraffic') === true;
    if (wantsNoTrafficTime) {
      baseQuery.computeTravelTimeFor = 'all';
    }

    const avoids = buildAvoids(options);
    if (avoids.length > 0) {
      baseQuery.avoid = avoids;
    }

    // Per-connector body merge: body is empty for this GET. Query carries the
    // vendor params + headers may be augmented by passthrough.
    const merged = mergePassthrough<Record<string, unknown>, QueryParams>(
      {},
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
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ConnectorError({
        message: 'TomTom Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Routing returned a malformed response body',
        cause: data,
      });
    }
    const routes = optionalArray(data.routes);
    if (routes === null) {
      throw malformedResponseError('TomTom Routing', '`routes` is not a list', response.status, data);
    }
    const route = routes[0] as TomTomRoute | null | undefined;
    if (route === undefined) {
      throw new ConnectorError({
        message: 'TomTom Routing returned no routes',
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage: 'TomTom Routing returned no routes',
        cause: data,
      });
    }

    // TomTom always sends each summary's length and travel time; a missing one
    // would otherwise be reported as 0 m / 0 s.
    if (!isRecord(route) || !hasLengthAndTime(route.summary)) {
      throw malformedResponseError(
        'TomTom Routing',
        'the first route has no summary length/travel time',
        response.status,
        data,
      );
    }
    const rawLegs = optionalArray(route.legs);
    if (rawLegs === null || rawLegs.some((leg) => !isRecord(leg) || !hasLengthAndTime(leg.summary))) {
      throw malformedResponseError(
        'TomTom Routing',
        'a leg has no summary length/travel time',
        response.status,
        data,
      );
    }
    const typedLegs = rawLegs as TomTomRoute['legs'];
    assertRouteHasLegs(typedLegs.length, waypoints.length, 'TomTom Routing', data, response.status);

    const legs = typedLegs.map((leg) => {
      const normalized: IRoutingLeg = {
        distanceMeters: leg.summary.lengthInMeters,
        durationSeconds: leg.summary.travelTimeInSeconds,
      };
      const noTraffic = leg.summary?.noTrafficTravelTimeInSeconds;
      if (wantsNoTrafficTime && typeof noTraffic === 'number') {
        normalized.durationWithoutTrafficSeconds = noTraffic;
      }
      return normalized;
    });

    // Flatten all leg points (TomTom uses { latitude, longitude } full-word
    // keys) into LatLng[] and re-encode to precision-5. A point missing a
    // coordinate is a body we cannot read, never a (0,0) vertex.
    const allPoints: LatLng[] = [];
    for (const leg of typedLegs) {
      const points = optionalArray(leg.points);
      if (points === null) {
        throw malformedResponseError('TomTom Routing', '`points` is not a list', response.status, data);
      }
      for (const p of points) {
        if (!isRecord(p) || !isFiniteNumber(p.latitude) || !isFiniteNumber(p.longitude)) {
          throw malformedResponseError(
            'TomTom Routing',
            'a route point has no latitude/longitude',
            response.status,
            data,
          );
        }
        allPoints.push({ lat: p.latitude, lng: p.longitude });
      }
    }
    const polyline = encodePolyline(allPoints);

    let waypointOrder: number[] | undefined;
    if (optimize && Array.isArray(data.optimizedWaypoints)) {
      // TomTom `optimizedWaypoints` covers only the INTERMEDIATE waypoints;
      // `providedIndex` is 0-based over those intermediates (origin and
      // destination excluded). The canonical `waypointOrder` is the full
      // visiting sequence of INPUT indices, so project each intermediate to its
      // input index (+1) and bracket with the fixed origin (0) and
      // destination (waypoints.length - 1).
      //
      // The projection is only meaningful if it yields a complete permutation:
      // a short, duplicated, or sentinel `providedIndex` list would otherwise
      // produce an ordering that silently drops or repeats a waypoint. Validate
      // and omit rather than emit a corrupt one.
      const intermediates = data.optimizedWaypoints
        .slice()
        .sort((a, b) => a.optimizedIndex - b.optimizedIndex)
        .map((wp) =>
          typeof wp.providedIndex === 'number'
            ? wp.providedIndex + 1
            : wp.providedIndex,
        );
      const candidate = [0, ...intermediates, waypoints.length - 1];
      if (isCompleteWaypointOrder(candidate, waypoints.length)) {
        waypointOrder = candidate;
      }
    }

    const totalNoTraffic = route.summary.noTrafficTravelTimeInSeconds;

    return {
      legs,
      totalDistanceMeters: route.summary.lengthInMeters,
      totalDurationSeconds: route.summary.travelTimeInSeconds,
      polyline,
      ...(waypointOrder !== undefined ? { waypointOrder } : {}),
      ...(wantsNoTrafficTime && typeof totalNoTraffic === 'number'
        ? { totalDurationWithoutTrafficSeconds: totalNoTraffic }
        : {}),
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
    body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    // TomTom reports an unroutable request as HTTP 400 with a machine-readable
    // `detailedError.code`, so the status alone cannot distinguish "no route"
    // from "malformed request" — read the code.
    const detailed = readTomTomErrorCode(body);
    if (detailed === 'MAP_MATCHING_FAILURE' || detailed === 'NO_ROUTE_FOUND') {
      return 'no_route';
    }

    if (httpStatus === 400 || httpStatus === 404) return 'invalid_request';
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

/**
 * Read `detailedError.code` from a TomTom error body.
 *
 * Live-verified: an unroutable request returns HTTP 400 with
 * `{ detailedError: { code: 'MAP_MATCHING_FAILURE', message: '… Origin (40, -30)' } }`.
 * `NO_ROUTE_FOUND` is TomTom's documented sibling code for the same class of
 * outcome; it is mapped too, but note it is doc-sourced rather than reproduced
 * live — every live attempt at a truly unreachable pair returned a route,
 * because TomTom (like every other provider tested) routes via ferries.
 */
function readTomTomErrorCode(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  const detailed = body.detailedError;
  if (detailed === null || typeof detailed !== 'object') return null;
  const code = (detailed as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

type TomTomRoute = TomTomRouteResponse['routes'][number];

function hasLengthAndTime(summary: unknown): boolean {
  return (
    isRecord(summary) &&
    isFiniteNumber(summary.lengthInMeters) &&
    isFiniteNumber(summary.travelTimeInSeconds)
  );
}

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

function buildAvoids(options: IRoutingOptions): string[] {
  const avoids: string[] = [];
  if (options.avoidTolls) avoids.push('tollRoads');
  if (options.avoidFerries) avoids.push('ferries');
  if (options.avoidHighways) avoids.push('motorways');
  return avoids;
}

function wantsOptimization(options: IRoutingOptions): boolean {
  return (
    options.optimize === true ||
    options.optimizeFixedOrigin === true ||
    options.optimizeFixedDestination === true
  );
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
