import { BaseConnector } from '../../base/base.connector';
import type { IRoutingConnector, IRoutingOptions, IRoutingResult } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import type { GoogleConfig } from './google.config';
import type { GoogleRoutesResponse } from './google.types';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Google Routes v2 connector — per-connector template.
 *
 * POSTs to https://routes.googleapis.com/directions/v2:computeRoutes with
 * `X-Goog-Api-Key` and `X-Goog-FieldMask` headers, normalizing the response
 * to {@link IRoutingResult} (meters, seconds, Google precision-5 polyline).
 * No retry, no caching, no stateful behaviour.
 *
 * Subsequent per-connector stories (1.7–1.29) follow this body shape:
 * 1. Build vendor body.
 * 2. {@link mergePassthrough} body / headers / query.
 * 3. Call {@link BaseConnector.sendPostJson} (or sendGet/sendPostForm).
 * 4. On non-2xx, parse body + raise {@link ConnectorError} with
 * {@link mapVendorError} ProviderCode + Retry-After surfacing by design.
 * 5. Normalize 2xx body into the operation result DTO.
 */
export class GoogleRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'google';

  constructor(private config: GoogleConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'Google Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'Google Routing requires at least two waypoints',
      });
    }
    const first = waypoints[0]!;
    const last = waypoints[waypoints.length - 1]!;

    // isRoundTrip: route returns to the first waypoint, so destination = origin.
    const destinationWp = options.isRoundTrip ? first : last;

    const origin = { location: { latLng: { latitude: first.lat, longitude: first.lng } } };
    const destination = {
      location: { latLng: { latitude: destinationWp.lat, longitude: destinationWp.lng } },
    };

    // For a round trip the final waypoint is also an intermediate (it is no
    // longer the destination); otherwise the last waypoint is the destination.
    const intermediates = (
      options.isRoundTrip ? waypoints.slice(1) : waypoints.slice(1, -1)
    ).map((wp) => ({
      location: { latLng: { latitude: wp.lat, longitude: wp.lng } },
    }));

    const body: Record<string, unknown> = {
      origin,
      destination,
      travelMode: this.mapTravelMode(options.travelMode),
      routingPreference: options.departureTime ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      polylineEncoding: 'ENCODED_POLYLINE',
    };

    if (intermediates.length > 0) {
      body.intermediates = intermediates;
    }

    // Any of optimize / optimizeFixedOrigin / optimizeFixedDestination /
    // isRoundTrip triggers Google's waypoint reordering. Google keeps origin
    // first and destination last by design (fixed-origin/fixed-destination
    // semantics), so all four flags map to the same vendor knob.
    const reorder =
      (options.optimize ||
        options.optimizeFixedOrigin ||
        options.optimizeFixedDestination ||
        options.isRoundTrip) === true;

    if (reorder && intermediates.length > 0) {
      body.optimizeWaypointOrder = true;
    }

    if (options.departureTime) {
      body.departureTime = options.departureTime.toISOString();
    }

    if (options.avoidTolls || options.avoidFerries || options.avoidHighways) {
      body.routeModifiers = {
        avoidTolls: options.avoidTolls ?? false,
        avoidFerries: options.avoidFerries ?? false,
        avoidHighways: options.avoidHighways ?? false,
      };
    }

    const fieldMask = [
      'routes.legs.distanceMeters',
      'routes.legs.duration',
      'routes.legs.staticDuration',
      'routes.distanceMeters',
      'routes.duration',
      'routes.staticDuration',
      'routes.polyline.encodedPolyline',
      ...(reorder ? ['routes.optimizedIntermediateWaypointIndex'] : []),
    ].join(',');

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask': fieldMask,
    };

    const merged = mergePassthrough(body, headers, options._passthrough);

    const response = await this.sendPostJson(ROUTES_URL, merged.body, {
      headers: merged.headers,
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const retryAfter = response.headers.get('retry-after');
      const cause =
        retryAfter !== null
          ? { ...(errorBody ?? {}), retryAfter }
          : errorBody;
      throw new ConnectorError({
        message: `Google Routing failed: ${response.status}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, retryAfter),
        cause,
      });
    }

    const data = (await response.json().catch(() => null)) as
      | GoogleRoutesResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'Google Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Google Routing returned a malformed response body',
        cause: data,
      });
    }
    const route = data.routes?.[0];
    if (!route) {
      throw new ConnectorError({
        message: 'Google Routing returned no routes',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Google Routing returned no routes',
        cause: data,
      });
    }

    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distanceMeters,
      durationSeconds: parseDuration(leg.duration),
    }));

    // Canonical `waypointOrder` = full visiting sequence of INPUT indices.
    // Google reports `optimizedIntermediateWaypointIndex` — the optimized
    // order of the INTERMEDIATE waypoints only, as 0-based intermediate
    // indices. Project to absolute input indices (`i + 1`, origin is 0),
    // prepend the origin (0) and append the destination (N - 1). For a round
    // trip Google treats every non-origin waypoint as an intermediate, so the
    // origin plus the projected intermediates already cover all input indices
    // and no separate destination is appended.
    let waypointOrder: number[] | undefined;
    const optimizedIntermediates = route.optimizedIntermediateWaypointIndex;
    if (Array.isArray(optimizedIntermediates)) {
      const projected = optimizedIntermediates.map((i) => i + 1);
      waypointOrder = options.isRoundTrip
        ? [0, ...projected]
        : [0, ...projected, waypoints.length - 1];
    }

    return {
      legs,
      totalDistanceMeters: route.distanceMeters,
      totalDurationSeconds: parseDuration(route.duration),
      polyline: route.polyline.encodedPolyline,
      ...(waypointOrder !== undefined ? { waypointOrder } : {}),
      raw: data,
    };
  }

  /**
   * Map (HTTP status, decoded body) → canonical {@link ProviderCode}. Per
   * (per-connector locality). */
  private mapVendorError(httpStatus: number, body: unknown): ProviderCode {
    const googleStatus = readGoogleErrorStatus(body);

    if (httpStatus === 401) return 'auth_failed';
    if (httpStatus === 403) {
      if (googleStatus === 'QUOTA_EXCEEDED') return 'rate_limited';
      return 'auth_failed';
    }
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present. No structured
   * `retryAfterSeconds` field on `ConnectorError`
   * by design.
   */
  private formatProviderMessage(
    body: unknown,
    retryAfter: string | null,
  ): string | null {
    const base = readGoogleErrorMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
  }

  private mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'WALK';
      case 'cycling':
        return 'BICYCLE';
      default:
        return 'DRIVE';
    }
  }
}

/** Parse Google duration string "123s" → number of seconds. */
function parseDuration(duration: string): number {
  return parseInt(duration.replace('s', ''), 10) || 0;
}

function readGoogleErrorStatus(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object' && 'status' in err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'string') return status;
    }
  }
  return null;
}

function readGoogleErrorMessage(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg !== '') return msg;
    }
  }
  return null;
}
