import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { joinCoords, mergePassthrough } from '../../utils';
import type { OsrmConfig } from './osrm.config';
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
    // required baseUrl. Throw synchronously before any HTTP.
    // The public demo server is intentionally not used as a default.
    if (
      config === null ||
      config === undefined ||
      typeof config.baseUrl !== 'string' ||
      config.baseUrl === ''
    ) {
      throw new ConnectorError({
        message:
          'OSRM connector requires explicit baseUrl. The public demo server is not used as a default.',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'baseUrl is required for OSRM',
      });
    }
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
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
    const url = `${this.config.baseUrl}/${endpoint}/v1/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      overview: 'full',
      geometries: 'polyline',
      steps: 'true',
      annotations: 'duration,distance',
    };

    if (useTrip) {
      const fixedOrigin = options.optimizeFixedOrigin === true;
      const fixedDestination = options.optimizeFixedDestination === true;
      baseQuery.source = fixedOrigin ? 'first' : 'any';
      baseQuery.destination = fixedDestination ? 'last' : 'any';
      baseQuery.roundtrip = options.isRoundTrip === true ? 'true' : 'false';
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
      throw await this.raiseHttpError(response);
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
    if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes[0]) {
      throw this.mapInBodyError(data, useTrip);
    }

    const route = data.routes[0];
    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distance,
      durationSeconds: leg.duration,
    }));

    // OSRM `geometries=polyline` returns precision-5 — no re-encoding.
    const polyline = typeof route.geometry === 'string' ? route.geometry : '';

    let waypointOrder: number[] | undefined;
    if (useTrip && Array.isArray(data.waypoints)) {
      // Canonical `waypointOrder` = full visiting sequence of INPUT indices
      // (origin/destination inclusive). OSRM `/trip` returns `waypoints[]` in
      // INPUT order, where each `waypoint_index` is the position that input
      // waypoint occupies in the optimized trip — i.e. the INVERSE of the
      // canonical. Invert it: place each input index at its visit position.
      const wps = data.waypoints;
      const order = new Array<number>(wps.length);
      let valid = true;
      for (let inputIdx = 0; inputIdx < wps.length; inputIdx++) {
        const pos = wps[inputIdx]?.waypoint_index;
        if (typeof pos !== 'number' || pos < 0 || pos >= wps.length) {
          valid = false;
          break;
        }
        order[pos] = inputIdx;
      }
      if (valid) {
        waypointOrder = order;
      }
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

    const avoidFlags: Array<keyof IRoutingOptions> = [
      'avoidTolls',
      'avoidFerries',
      'avoidHighways',
    ];
    for (const flag of avoidFlags) {
      if (options[flag] === true) {
        throw new ConnectorError({
          message: `OSRM does not support ${flag}`,
          statusCode: null,
          providerCode: 'unsupported_option',
          providerMessage: `${flag} is not supported by OSRM`,
        });
      }
    }

    // Invalid `/trip` combo: source=any, destination=any, roundtrip=false is
    // not a legal OSRM combination. We can only hit it when at least one
    // optimization flag is set (otherwise we dispatch to `/route`).
    const useTrip =
      options.optimize === true ||
      options.optimizeFixedOrigin === true ||
      options.optimizeFixedDestination === true ||
      options.isRoundTrip === true;

    if (
      useTrip &&
      options.isRoundTrip === false &&
      options.optimizeFixedOrigin !== true &&
      options.optimizeFixedDestination !== true
    ) {
      throw new ConnectorError({
        message:
          'OSRM /trip does not support source=any, destination=any, roundtrip=false',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage:
          'When isRoundTrip=false, OSRM /trip requires optimizeFixedOrigin or optimizeFixedDestination',
      });
    }
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx HTTP
   * responses. Surfaces Retry-After in `providerMessage` and `cause`
   * by design (no structured retry
   * field). Vanilla OSRM has no auth/no rate-limiting; consumer reverse
   * proxies may add 401/429 — we surface those statuses as-is.
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
      message: `OSRM routing failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
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
    _body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400 || httpStatus === 404) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  /**
   * Map an in-body OSRM status code (`data.code !== 'Ok'`) to a typed
   * {@link ConnectorError}. OSRM occasionally returns HTTP 200 with
   * a non-Ok envelope code such as `NoRoute`, `NoSegment`, `InvalidQuery`,
   * `InvalidOptions`, or (trip endpoint) `NoTrips`.
   *
   * Profile-mismatch detection: if `body.code === 'NoRoute'` and the
   * `body.message` carries an explicit "profile not found" signal, raise
   * `'profile_not_configured'`. Otherwise default to `'invalid_request'`. We
   * do NOT auto-detect missing profiles from a generic NoRoute — too brittle.
   */
  private mapInBodyError(
    body: { code?: string; message?: string },
    useTrip: boolean,
  ): ConnectorError {
    const code = typeof body.code === 'string' ? body.code : '';
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : '';

    let providerCode: ProviderCode;
    switch (code) {
      case 'NoRoute':
      case 'NoSegment':
        providerCode =
          message !== '' && /profile\s+not\s+found/i.test(message)
            ? 'profile_not_configured'
            : 'invalid_request';
        break;
      case 'InvalidQuery':
      case 'InvalidOptions':
        providerCode = 'invalid_request';
        break;
      case 'NoTrips':
        // `NoTrips` is a `/trip`-endpoint outcome: no trip could be found for
        // the given coordinates. On a `/route` dispatch it should never occur,
        // so classify an unexpected `NoTrips` there as `'unknown'`.
        providerCode = useTrip ? 'invalid_request' : 'unknown';
        break;
      default:
        providerCode = 'unknown';
        break;
    }

    const providerMessage =
      message !== '' ? message : `OSRM returned code: ${code || 'unknown'}`;

    return new ConnectorError({
      message: providerMessage,
      statusCode: null,
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
 * these use the OSRM-standard names
 * `driving / walking / cycling`. The {@link OsrmMatrixConnector} sibling maps
 * to the identical `driving / walking / cycling` profile names, so both
 * connectors share the same OSRM-standard convention. Consumers are
 * responsible for verifying that their OSRM build has the requested profile
 * compiled (`'profile_not_configured'` check).
 */
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
