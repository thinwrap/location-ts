import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  assertRouteHasLegs,
  invertWaypointPositions,
  joinCoords,
  mergePassthrough,
} from '../../utils';
import { validateOsrmBaseUrl } from './osrm.base-url';
import type { OsrmConfig, OsrmExcludeClass } from './osrm.config';
import type { OsrmRouteResponse } from './osrm.types';

/**
 * OSRM routing connector — architectural outlier.
 *
 * Two distinct dispatches based on optimization flags on
 * {@link IRoutingOptions}:
 *
 *   - `GET <baseUrl>/route/v1/{profile}/{coords}` — plain routing (no
 *     optimization flag set).
 *   - `GET <baseUrl>/trip/v1/{profile}/{coords}`  — when any of
 *     `optimize | optimizeFixedOrigin | optimizeFixedDestination | isRoundTrip`
 * is set.
 *
 * Pre-flight validation runs synchronously at the top of `.route()`
 * before any HTTP work. The pre-flight checks raise typed
 * {@link ConnectorError} with `statusCode: null` for the location-extended
 * ProviderCode values:
 *   - `'unsupported_field'`   — `departureTime` set.
 *   - `'unsupported_option'`  — any of `avoidTolls | avoidFerries | avoidHighways` set.
 *   - `'invalid_request'`     — invalid `/trip` combo (source=any, destination=any, roundtrip=false).
 *
 * the dispatch logic + error classification live entirely inside
 * this connector — there is no shared translator middleware. There
 * is no auth surface: consumers needing auth front their OSRM instance with a
 * reverse proxy (see per-connector README).
 *
 * Travel-mode mapping uses the OSRM-standard profile names
 * `'driving' | 'walking' | 'cycling'` — verify against the consumer's OSRM
 * build (`profile_not_configured` is raised otherwise).
 */
export class OsrmRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'osrm';

  constructor(private config: OsrmConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    // Validated at CALL time, not construction time: a facade built at module
    // load from environment config should not throw at import. Matches the
    // location-go / location-py siblings, which already validate here.
    const baseUrl = validateOsrmBaseUrl(this.config);

    // pre-flight validation runs synchronously before any HTTP call.
    this.validateOsrmCompat(options);

    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'OSRM Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'OSRM Routing requires at least two waypoints',
      });
    }

    const useTrip =
      options.optimize === true ||
      options.optimizeFixedOrigin === true ||
      options.optimizeFixedDestination === true ||
      options.isRoundTrip === true;

    const profile = mapProfile(options.travelMode);
    // OSRM coordinates: `lng,lat;lng,lat;...` (note OSRM's lng,lat order).
    const coords = joinCoords(waypoints, 'lnglat', ';');

    const endpoint = useTrip ? 'trip' : 'route';
    const url = `${baseUrl}/${endpoint}/v1/${profile}/${coords}`;

    // `steps` and `annotations` are deliberately NOT sent on /route: nothing in
    // `IRoutingResult` reads them, and leg `distance`/`duration` are present
    // regardless of `annotations`. (The Table service is different — it forces
    // `annotations=duration,distance` because that IS what populates the cells.)
    const baseQuery: Record<string, string> = {
      overview: options.polylineQuality === 'detailed' ? 'full' : 'simplified',
      geometries: 'polyline',
    };

    // Only classes the operator declared AND the caller asked for; validation
    // above has already rejected any undeclared request.
    const excludes = OSRM_AVOID_FLAGS.filter(
      ([flag]) => options[flag] === true,
    ).map(([, excludeClass]) => excludeClass);
    if (excludes.length > 0) {
      baseQuery.exclude = excludes.join(',');
    }

    if (useTrip) {
      const roundtrip = options.isRoundTrip === true;
      let source = options.optimizeFixedOrigin === true ? 'first' : 'any';
      let destination = options.optimizeFixedDestination === true ? 'last' : 'any';
      // OSRM rejects source=any + destination=any together with roundtrip=false
      // (HTTP 400 NotImplemented). A plain `optimize` (neither endpoint fixed,
      // open route) therefore keeps the input's first & last fixed and reorders
      // the middle — matching the Mapbox Optimization v1 sibling. Every other
      // combo (any fixed endpoint, or roundtrip=true) is already legal.
      if (!roundtrip && source === 'any' && destination === 'any') {
        source = 'first';
        destination = 'last';
      }
      baseQuery.source = source;
      baseQuery.destination = destination;
      baseQuery.roundtrip = roundtrip ? 'true' : 'false';
    }

    // 4-arg mergePassthrough: deep-merge body, shallow-merge headers + query.
    // No connector body for OSRM (GET).
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
      throw await this.raiseHttpError(response, useTrip);
    }

    const data = (await response.json().catch(() => null)) as
      | OsrmRouteResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'OSRM routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'OSRM routing returned a malformed response body',
        cause: data,
      });
    }

    // OSRM in-body status codes trigger typed errors even on HTTP 200.
    // The `/trip/v1` service returns its route objects under `trips`, not
    // `routes`; fall back to it when `routes` is absent/empty.
    let routes = Array.isArray(data.routes) ? data.routes : undefined;
    if ((!routes || routes.length === 0) && Array.isArray(data.trips)) {
      routes = data.trips;
    }
    if (data.code !== 'Ok' || !routes || !routes[0]) {
      throw this.mapInBodyError(data, useTrip, response.status);
    }

    const route = routes[0];
    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distance,
      durationSeconds: leg.duration,
    }));
    assertRouteHasLegs(legs.length, waypoints.length, 'OSRM routing', data);

    // OSRM `geometries=polyline` returns precision-5 — no re-encoding.
    const polyline = typeof route.geometry === 'string' ? route.geometry : '';

    let waypointOrder: number[] | undefined;
    if (useTrip && Array.isArray(data.waypoints)) {
      // Canonical `waypointOrder` = full visiting sequence of INPUT indices
      // (origin/destination inclusive). OSRM `/trip` returns `waypoints[]` in
      // INPUT order, where each `waypoint_index` is the position that input
      // waypoint occupies in the optimized trip — i.e. the INVERSE of the
      // canonical. Invert it: place each input index at its visit position.
      // Validated against the INPUT waypoint count, so a truncated or
      // duplicate-index `waypoints[]` omits the ordering instead of yielding a
      // permutation that silently drops or repeats a waypoint.
      waypointOrder = invertWaypointPositions(
        data.waypoints.map((wp) => wp?.waypoint_index),
        options.waypoints.length,
      );
    }

    return {
      legs,
      totalDistanceMeters: route.distance,
      totalDurationSeconds: route.duration,
      polyline,
      ...(waypointOrder !== undefined ? { waypointOrder } : {}),
      raw: data,
    };
  }

  /**
   * Pre-flight validation raising typed {@link ConnectorError}
   * with `statusCode: null` for OSRM-incompatible inputs. Runs at the top of
   * `.route()` before any HTTP work.
   *
   * Order matters: `departureTime` first, then the three avoid-flags (first
   * one set wins), then the invalid `/trip` combination check.
   */
  private validateOsrmCompat(options: IRoutingOptions): void {
    if (options.departureTime !== undefined) {
      throw new ConnectorError({
        message: 'OSRM does not support departureTime',
        statusCode: null,
        providerCode: 'unsupported_field',
        providerMessage: 'OSRM does not support departureTime',
      });
    }

    // Whether an avoid-flag works depends on the OPERATOR'S build, not on OSRM:
    // `exclude=toll` is rejected as `InvalidValue` by the public demo build and
    // honoured by a self-hosted instance with the class compiled in. So the
    // capability is declared in config, and anything not declared is still
    // rejected up front rather than sent and bounced with an opaque error.
    const supported = this.config?.supportedExcludeClasses ?? [];
    for (const [flag, excludeClass] of OSRM_AVOID_FLAGS) {
      if (options[flag] === true && !supported.includes(excludeClass)) {
        throw new ConnectorError({
          message: `OSRM does not support ${flag}`,
          statusCode: null,
          providerCode: 'unsupported_option',
          providerMessage: `${flag} requires an OSRM build with the '${excludeClass}' exclude class compiled in; declare it via OsrmConfig.supportedExcludeClasses`,
        });
      }
    }
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx HTTP
   * responses. Surfaces Retry-After in `providerMessage` and `cause`
   * by design (no structured retry
   * field). Vanilla OSRM has no auth/no rate-limiting; consumer reverse
   * proxies may add 401/429 — we surface those statuses as-is.
   */
  private async raiseHttpError(response: Response, useTrip: boolean): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null
        ? { ...(errorBody ?? {}), retryAfter }
        : errorBody;
    return new ConnectorError({
      message: `OSRM routing failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody, useTrip),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map OSRM (HTTP status, body) → canonical {@link ProviderCode}.
   * Vanilla OSRM has no auth + no rate-limits, but consumer reverse proxies
   * may add 401/429 — we surface those as-is. the mapping lives
   * per-connector (no shared middleware).
   */
  private mapVendorError(
    httpStatus: number,
    body: Record<string, unknown> | null,
    useTrip: boolean,
  ): ProviderCode {
    // Proxy-layer statuses win: a 401/429 from a reverse proxy has no OSRM
    // envelope to read.
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    // OSRM serves EVERY non-Ok envelope code with a 4xx (verified live against
    // both the demo build and a self-hosted instance: NoSegment, InvalidOptions
    // and InvalidValue all arrive as 400). So the envelope code — not the status
    // — is what distinguishes "no route exists" from "your request was wrong",
    // and it must be read here rather than only on the 200 path.
    const classified = classifyOsrmEnvelopeCode(body, useTrip);
    if (classified !== null) return classified;

    if (httpStatus === 400 || httpStatus === 404) return 'invalid_request';
    return 'unknown';
  }

  /**
   * Map an in-body OSRM envelope to a typed error. Reached on a 2xx whose envelope
   * code is not `Ok`, or whose `routes` / `trips` array is empty.
   *
   * `Ok` with an empty `routes[]` is `no_route`: the envelope says the request was
   * fine and the server answered, so there is nothing to return. Google's empty
   * `routes[]` maps the same way.
   *
   * A `NoRoute` whose message names a missing profile is `profile_not_configured`
   * instead; that is never inferred from a bare `NoRoute`.
   *
   * `statusCode` is the real status, not `null` — this path is only reachable on a
   * 2xx, and nulling it made an answered request look like a transport failure.
   */
  private mapInBodyError(
    body: { code?: string; message?: string },
    useTrip: boolean,
    statusCode: number,
  ): ConnectorError {
    const code = typeof body.code === 'string' ? body.code : '';
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : '';

    const isEmptyOk = code === 'Ok';
    const providerCode = isEmptyOk
      ? 'no_route'
      : (classifyOsrmEnvelopeCode(body, useTrip) ?? 'unknown');

    const providerMessage =
      message !== '' && !isEmptyOk
        ? message
        : isEmptyOk
          ? `OSRM returned ${useTrip ? 'no trips' : 'no routes'} with envelope code Ok`
          : `OSRM returned code: ${code || 'unknown'}`;

    return new ConnectorError({
      message: providerMessage,
      statusCode,
      providerCode,
      providerMessage,
      cause: body,
    });
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design (no structured retry field).
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readOsrmErrorMessage(body);

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
 * Map base {@link IRoutingOptions.travelMode} to an OSRM profile name.
 *
 * The three base modes map 1:1 onto the OSRM-standard profile names
 * `driving / walking / cycling`, matching {@link OsrmMatrixConnector}.
 *
 * Which profiles exist is a property of the operator's build, so a name that maps
 * cleanly here can still be absent server-side — hence the
 * `'profile_not_configured'` classification.
 */
/**
 * Classify an OSRM envelope `code` into a {@link ProviderCode}, or `null` when
 * the body carries no code this connector recognizes (so the caller falls back
 * to HTTP-status mapping).
 *
 * Shared by both error paths because OSRM does not distinguish them: the codes
 * below arrive with a 4xx status in practice, and the same code on a 200 means
 * the same thing.
 *
 * - `NoRoute` / `NoSegment` / `NoTrips` → `no_route`: the request was
 *   well-formed and the server answered, there simply is no connecting route
 *   (or no road near a coordinate to snap to). A business outcome, not a bug.
 * - `InvalidQuery` / `InvalidOptions` / `InvalidValue` → `invalid_request`.
 *
 * A `NoRoute` whose message carries an explicit "profile not found" signal is
 * `profile_not_configured` instead — an operator error, not a missing route.
 * Missing profiles are NOT inferred from a generic `NoRoute` (too brittle).
 */
function classifyOsrmEnvelopeCode(
  body: { code?: unknown; message?: unknown } | null,
  useTrip: boolean,
): ProviderCode | null {
  if (body === null) return null;
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';

  switch (code) {
    case 'NoRoute':
    case 'NoSegment':
      return message !== '' && /profile\s+not\s+found/i.test(message)
        ? 'profile_not_configured'
        : 'no_route';
    case 'NoTrips':
      // A `/trip`-endpoint outcome. On a `/route` dispatch it should never
      // occur, so an unexpected one stays unclassified rather than being
      // reported as a routing outcome.
      return useTrip ? 'no_route' : null;
    case 'InvalidQuery':
    case 'InvalidOptions':
    case 'InvalidValue':
      return 'invalid_request';
    default:
      return null;
  }
}

/**
 * The normalized avoid-flag → OSRM `exclude` class mapping. Ordered, so the
 * first unsupported flag is the one reported.
 */
const OSRM_AVOID_FLAGS: ReadonlyArray<[keyof IRoutingOptions, OsrmExcludeClass]> = [
  ['avoidTolls', 'toll'],
  ['avoidFerries', 'ferry'],
  ['avoidHighways', 'motorway'],
];

function mapProfile(mode?: 'driving' | 'walking' | 'cycling'): string {
  switch (mode) {
    case 'walking':
      return 'walking';
    case 'cycling':
      return 'cycling';
    default:
      return 'driving';
  }
}

function readOsrmErrorMessage(
  body: Record<string, unknown> | null,
): string | null {
  if (body === null) return null;
  if (typeof body.message === 'string' && body.message !== '') {
    return body.message;
  }
  if (typeof body.error === 'string' && body.error !== '') {
    return body.error;
  }
  return null;
}
