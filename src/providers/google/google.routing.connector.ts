import { BaseConnector, isErrorBodyUnavailable } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingLeg,
  IRoutingOptions,
  IRoutingResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import {
  assertRouteHasLegs,
  isCompleteWaypointOrder,
  isRecord,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
} from '../../utils';
import { validateRoutingOptions } from '../../utils/validate-options';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import { isTrafficRequested } from '../../utils/traffic';
import type { GoogleConfig } from './google.config';
import {
  GOOGLE_ROUTES_FIELD_MASK,
  GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC,
  GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER,
} from './google.defaults';
import type { GoogleRoutesResponse } from './google.types';
import { mapGoogleReason, readGoogleErrorReason } from './google.error-reason';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Google Routes v2 connector.
 *
 * POSTs to https://routes.googleapis.com/directions/v2:computeRoutes with
 * `X-Goog-Api-Key` and `X-Goog-FieldMask` headers, normalizing the response
 * to {@link IRoutingResult} (meters, seconds, Google precision-5 polyline).
 * No retry, no caching, no stateful behaviour.
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
    validateRoutingOptions(options, 'Google Routing');
    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'Google Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'Google Routing requires at least two waypoints',
      });
    }
    // Reject NaN/non-finite coordinates before they serialize into the request
    // body (out-of-range but finite lat/lng pass through verbatim — thin-wrapper).
    for (const wp of waypoints) {
      assertFiniteCoordinate(wp, 'Google routing waypoint');
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

    const travelMode = this.mapTravelMode(options.travelMode);
    const body: Record<string, unknown> = {
      origin,
      destination,
      travelMode,
      polylineEncoding: 'ENCODED_POLYLINE',
      // OVERVIEW is Google's own default; naming it explicitly makes the
      // normalized default visible in the request and lets 'detailed' opt up.
      polylineQuality:
        options.polylineQuality === 'detailed' ? 'HIGH_QUALITY' : 'OVERVIEW',
    };

    // Google rejects `routingPreference` for WALK/BICYCLE ("Routing preference
    // cannot be set for WALK or BICYCLE routing mode.") — only DRIVE and
    // TWO_WHEELER accept it. Overridable via `_passthrough.body`.
    //
    // `TRAFFIC_AWARE` is a **Pro-tier SKU feature** on Compute Routes while the
    // base tier is Essentials, so it is driven by the explicit `trafficMode`
    // opt-in and NOT by the presence of `departureTime` — deriving it from a
    // departure time would silently move a caller onto Pro pricing for asking
    // about a future trip.
    const traffic = isTrafficRequested(options.trafficMode);
    if (travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER') {
      body.routingPreference = traffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE';
    }

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

    // The departure time is sent only with traffic. Google answers HTTP 400
    // "Timestamp cannot be set for TRAFFIC_UNAWARE routing mode." when both are
    // present, and documents that an unaware route is computed on
    // time-independent speeds, so under `'none'` the time could change nothing.
    if (options.departureTime && traffic) {
      body.departureTime = options.departureTime.toISOString();
    }

    if (options.avoidTolls || options.avoidFerries || options.avoidHighways) {
      body.routeModifiers = {
        avoidTolls: options.avoidTolls ?? false,
        avoidFerries: options.avoidFerries ?? false,
        avoidHighways: options.avoidHighways ?? false,
      };
    }

    // Google's field mask is mandatory AND governs the response size, so it is
    // built from what the caller actually asked for.
    const wantsStaticDuration =
      options.include?.includes('durationWithoutTraffic') === true;

    const fieldMask = [
      ...GOOGLE_ROUTES_FIELD_MASK,
      ...(wantsStaticDuration ? GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC : []),
      ...(reorder ? GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER : []),
    ].join(',');

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask': fieldMask,
    };

    const merged = mergePassthrough(body, headers, options._passthrough);

    const response = await this.sendPostJson(ROUTES_URL, merged.body, {
      headers: merged.headers,
      query: merged.query,
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
    if (!isRecord(data)) {
      throw new ConnectorError({
        message: 'Google Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Google Routing returned a malformed response body',
        cause: data,
      });
    }
    const routes = optionalArray(data.routes);
    if (routes === null) {
      throw malformedResponseError('Google Routing', '`routes` is not a list', response.status, data);
    }
    if (routes.length === 0) {
      // Google signals "no route exists" as HTTP 200 with an empty (or, since
      // proto3 drops empty lists, absent) `routes[]`, not as an error status.
      throw new ConnectorError({
        message: 'Google Routing returned no routes',
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage: 'Google Routing returned no routes',
        cause: data,
      });
    }
    const route = routes[0] as GoogleRoutesResponse['routes'][number] | null;
    if (!isRecord(route)) {
      throw malformedResponseError('Google Routing', 'the first route is not an object', response.status, data);
    }

    const rawLegs = optionalArray(route.legs);
    if (rawLegs === null || rawLegs.some((leg) => !isRecord(leg))) {
      throw malformedResponseError('Google Routing', '`legs` is not a list of objects', response.status, data);
    }
    // No legs for a multi-waypoint route describes no journey. (A replacing
    // `X-Goog-FieldMask` without `routes.legs.*` produces exactly this.)
    assertRouteHasLegs(rawLegs.length, waypoints.length, 'Google Routing', data, response.status);

    // Google's JSON drops zero-valued fields (proto3), so an absent distance or
    // duration on a returned leg/route is 0 by definition, not missing data.
    const legs = (rawLegs as NonNullable<typeof route.legs>).map((leg) => {
      const normalized: IRoutingLeg = {
        distanceMeters: leg.distanceMeters ?? 0,
        durationSeconds: parseDuration(leg.duration ?? '0s'),
      };
      // Only when asked for AND actually returned — never synthesized from
      // `duration`, so absence stays meaningful.
      if (wantsStaticDuration && typeof leg.staticDuration === 'string') {
        normalized.durationWithoutTrafficSeconds = parseDuration(leg.staticDuration);
      }
      return normalized;
    });

    // Canonical `waypointOrder` = full visiting sequence of INPUT indices.
    // Google reports `optimizedIntermediateWaypointIndex` — the optimized
    // order of the INTERMEDIATE waypoints only, as 0-based intermediate
    // indices. Project to absolute input indices (`i + 1`, origin is 0),
    // prepend the origin (0) and append the destination (N - 1). For a round
    // trip Google treats every non-origin waypoint as an intermediate, so the
    // origin plus the projected intermediates already cover all input indices
    // and no separate destination is appended.
    //
    // Google does not always return real indices: when it declines to optimize
    // it answers `[-1]`, which projects to `[0, 0, N-1]` — a corrupt ordering
    // that duplicates the origin and drops a waypoint. Validate the projection
    // and omit it unless it is a complete permutation.
    let waypointOrder: number[] | undefined;
    const optimizedIntermediates = route.optimizedIntermediateWaypointIndex;
    if (Array.isArray(optimizedIntermediates)) {
      const projected = optimizedIntermediates.map((i) =>
        typeof i === 'number' ? i + 1 : i,
      );
      const candidate = options.isRoundTrip
        ? [0, ...projected]
        : [0, ...projected, waypoints.length - 1];
      if (isCompleteWaypointOrder(candidate, waypoints.length)) {
        waypointOrder = candidate;
      }
    }

    return {
      legs,
      totalDistanceMeters: route.distanceMeters ?? 0,
      totalDurationSeconds: parseDuration(route.duration ?? '0s'),
      polyline: route.polyline?.encodedPolyline ?? '',
      ...(waypointOrder !== undefined ? { waypointOrder } : {}),
      ...(wantsStaticDuration && typeof route.staticDuration === 'string'
        ? {
            totalDurationWithoutTrafficSeconds: parseDuration(route.staticDuration),
          }
        : {}),
      raw: data,
    };
  }

  /**
   * Map (HTTP status, decoded body) → canonical {@link ProviderCode}. Lives on the
   * connector rather than in `BaseConnector`: error translation is per-provider.
   */
  private mapVendorError(httpStatus: number, body: unknown): ProviderCode {
    // Prefer the structured google.rpc.ErrorInfo reason (robust) over the HTTP
    // status: Google returns 400 INVALID_ARGUMENT for an invalid key, which the
    // status-only mapping below would misread as invalid_request.
    const reasonCode = mapGoogleReason(readGoogleErrorReason(body));
    if (reasonCode !== null) return reasonCode;

    const googleStatus = readGoogleErrorStatus(body);

    // Google answers HTTP 400 for BOTH an invalid key and a malformed request —
    // only `error.details[].reason` separates them, and the headers are
    // byte-identical (verified live). So when the body never reached us, the
    // status-only fallback below cannot justify `invalid_request`: say `unknown`
    // rather than confidently blame the caller's request.
    if (isErrorBodyUnavailable(body)) return 'unknown';

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
