import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { decodeFlexPolyline, encodePolyline, mergePassthrough } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { HereConfig } from './here.config';
import type {
  HereRouteResponse,
  HereRoutingOptions,
  HereSequenceResponse,
} from './here.types';

const ROUTER_URL = 'https://router.hereapi.com/v8/routes';
const SEQUENCE_URL = 'https://wps.hereapi.com/v8/findsequence2';

/**
 * HERE Routing v8 connector — architectural outlier.
 *
 * Two endpoints, two dispatch shapes:
 *
 *   - `GET https://router.hereapi.com/v8/routes` for plain routing.
 *   - **Two-call** workflow when any optimization flag is set:
 *       1. `GET https://wps.hereapi.com/v8/findsequence2` computes the order.
 *       2. `GET https://router.hereapi.com/v8/routes` with reordered `via`.
 *
 * both calls live entirely inside this connector. The polyline
 * payload is HERE flex-polyline; we re-encode to Google precision-5
 * via {@link decodeFlexPolyline} + {@link encodePolyline}.
 *
 * Provider-narrowed input: {@link HereRoutingOptions} extends
 * {@link IRoutingOptions} with an optional {@link HereTransportMode}. When set
 * it overrides the base `travelMode` mapping.
 */
export class HereRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'here';

  constructor(private config: HereConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'HERE Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'HERE Routing requires at least two waypoints',
      });
    }

    // Reject NaN/non-finite waypoints before they serialize into the URL query
    // (`${NaN}` becomes the string "NaN"); both dispatch shapes below
    // (callFindSequence + callRoutes) read the same coordinates. Out-of-range
    // but finite lat/lng pass through verbatim (thin-wrapper philosophy).
    for (const wp of waypoints) {
      assertFiniteCoordinate(wp, 'HERE Routing waypoint');
    }

    // HERE findsequence2 optimizes an OPEN route (fixed first/last waypoint); it
    // cannot return a closed round trip. Surface the unsupported flag instead of
    // silently returning an open route (parity with OSRM's unsupported-combo guard).
    if (options.isRoundTrip === true) {
      throw new ConnectorError({
        message: 'HERE route optimization does not support round trips (isRoundTrip)',
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage:
          'HERE findsequence2 optimizes an open route (fixed first/last waypoint) and cannot return a closed round trip; remove isRoundTrip or use a provider that supports it (e.g. Mapbox/OSRM).',
      });
    }

    // (isRoundTrip === true already threw above; it no longer contributes here.)
    const useOptimization =
      options.optimize === true ||
      options.optimizeFixedOrigin === true ||
      options.optimizeFixedDestination === true;

    let orderedWaypoints: LatLng[] = waypoints;
    let waypointOrder: number[] | undefined;

    if (useOptimization && waypoints.length > 2) {
      const sequence = await this.callFindSequence(waypoints, options);
      // The returned sequence must be a permutation of [0..N-1] before it can
      // be used to reorder waypoints; otherwise `waypoints[i]` may be undefined
      // or a waypoint may be dropped/duplicated.
      const n = waypoints.length;
      const seen = new Array<boolean>(n).fill(false);
      let validPermutation = sequence.length === n;
      if (validPermutation) {
        for (const i of sequence) {
          if (!Number.isInteger(i) || i < 0 || i >= n || seen[i]) {
            validPermutation = false;
            break;
          }
          seen[i] = true;
        }
      }
      if (!validPermutation) {
        throw new ConnectorError({
          message: 'HERE findsequence2 returned an invalid waypoint ordering',
          statusCode: null,
          providerCode: 'unknown',
          providerMessage:
            'HERE findsequence2 returned an invalid waypoint ordering',
          cause: { sequence },
        });
      }
      orderedWaypoints = sequence.map((i) => waypoints[i] as LatLng);
      // Canonical `waypointOrder` = full visiting sequence of INPUT indices
      // (origin/destination inclusive). `sequence` already is exactly that
      // (absolute input indices in visit order); emit it verbatim.
      waypointOrder = sequence;
    }

    const direct = await this.callRoutes(orderedWaypoints, options);
    return { ...direct, waypointOrder };
  }

  /** Plain `/v8/routes` GET dispatch. */
  private async callRoutes(
    waypoints: LatLng[],
    options: IRoutingOptions,
  ): Promise<IRoutingResult> {
    const first = waypoints[0]!;
    const last = waypoints[waypoints.length - 1]!;
    const intermediates = waypoints.slice(1, -1);

    const transportMode = this.resolveTransportMode(options);

    const baseQuery: Record<string, string> = {
      apiKey: this.config.apiKey,
      transportMode,
      return: 'polyline,summary',
      routingMode: 'fast',
      origin: `${formatCoord(first.lat)},${formatCoord(first.lng)}`,
      destination: `${formatCoord(last.lat)},${formatCoord(last.lng)}`,
    };

    if (options.departureTime) {
      baseQuery.departureTime = options.departureTime.toISOString();
    }

    const avoidFeatures = buildAvoidFeatures(options);
    if (avoidFeatures !== '') {
      baseQuery['avoid[features]'] = avoidFeatures;
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    // HERE accepts repeated `via` query parameters; URLSearchParams handles
    // duplicate keys correctly via .append (NOT .set).
    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(merged.query)) {
      urlParams.append(key, val);
    }
    for (const wp of intermediates) {
      urlParams.append('via', `${formatCoord(wp.lat)},${formatCoord(wp.lng)}`);
    }

    const url = `${ROUTER_URL}?${urlParams.toString()}`;
    const response = await this.sendGet(url, { headers: merged.headers });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Routing');
    }

    const data = (await response.json().catch(() => null)) as
      | HereRouteResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Routing returned a malformed response body',
        cause: data,
      });
    }
    const route = data.routes?.[0];
    if (!route) {
      throw new ConnectorError({
        message: 'HERE Routing returned no routes',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Routing returned no routes',
        cause: data,
      });
    }

    const allCoords: LatLng[] = [];
    const legs = (route.sections ?? []).map((section) => {
      if (typeof section.polyline === 'string' && section.polyline !== '') {
        allCoords.push(...decodeFlexPolyline(section.polyline));
      }
      return {
        distanceMeters: section.summary?.length ?? 0,
        durationSeconds: section.summary?.duration ?? 0,
      };
    });

    const totalDistanceMeters = legs.reduce((s, l) => s + l.distanceMeters, 0);
    const totalDurationSeconds = legs.reduce((s, l) => s + l.durationSeconds, 0);

    return {
      legs,
      totalDistanceMeters,
      totalDurationSeconds,
      polyline: encodePolyline(allCoords),
      raw: data,
    };
  }

  /**
   * First leg of the two-call optimization: `/v8/findsequence2`.
   * Returns the absolute sequence of waypoint indices (origin first,
   * destination last, intermediates between).
   */
  private async callFindSequence(
    waypoints: LatLng[],
    options: IRoutingOptions,
  ): Promise<number[]> {
    const first = waypoints[0]!;
    const last = waypoints[waypoints.length - 1]!;
    const intermediates = waypoints.slice(1, -1);

    const transportMode = this.resolveTransportMode(options);

    const baseQuery: Record<string, string> = {
      apiKey: this.config.apiKey,
      start: `${formatCoord(first.lat)},${formatCoord(first.lng)}`,
      end: `${formatCoord(last.lat)},${formatCoord(last.lng)}`,
      mode: `fastest;${transportMode};traffic:disabled`,
    };

    if (options.departureTime) {
      // HERE findsequence2 documents the departure-time param as `departure`
      // (ISO 8601); `departureTime` is not recognized and was silently ignored,
      // so traffic-aware sequencing never took effect.
      baseQuery.departure = options.departureTime.toISOString();
    }

    // Merge `_passthrough` (query + headers) into this leg too — it was silently
    // dropped, so a consumer could not tune the sequence request (e.g. `improveFor`,
    // `mode` overrides). The connector query (including the per-intermediate
    // destinationN keys) is the base; passthrough.query overrides on collision.
    const connectorQuery: Record<string, string> = { ...baseQuery };
    for (let i = 0; i < intermediates.length; i++) {
      const wp = intermediates[i]!;
      connectorQuery[`destination${i + 1}`] = `${formatCoord(wp.lat)},${formatCoord(wp.lng)}`;
    }
    const merged = mergePassthrough({} as Record<string, unknown>, {}, options._passthrough, connectorQuery);

    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(merged.query)) {
      urlParams.append(key, val);
    }

    const url = `${SEQUENCE_URL}?${urlParams.toString()}`;
    const response = await this.sendGet(url, { headers: merged.headers });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Waypoints Sequence');
    }

    const data = (await response.json().catch(() => null)) as
      | HereSequenceResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE findsequence2 returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE findsequence2 returned a malformed response body',
        cause: data,
      });
    }
    const sequenceResult = data.results?.[0];
    if (!sequenceResult || !Array.isArray(sequenceResult.waypoints)) {
      throw new ConnectorError({
        message: 'HERE findsequence2 returned no sequence',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE findsequence2 returned no sequence',
        cause: data,
      });
    }

    // Each waypoint: { id: 'start' | 'destinationN' | 'end', sequence: int }.
    const entries = sequenceResult.waypoints
      .filter(
        (wp): wp is { id: string; lat: number; lng: number; sequence: number } =>
          typeof wp?.id === 'string' && typeof wp?.sequence === 'number',
      )
      .slice()
      .sort((a, b) => a.sequence - b.sequence);

    const lastIndex = waypoints.length - 1;
    const absolute: number[] = [];
    for (const entry of entries) {
      const id = entry.id;
      if (id === 'start') {
        absolute.push(0);
      } else if (id === 'end') {
        absolute.push(lastIndex);
      } else if (id.startsWith('destination')) {
        const n = parseInt(id.substring('destination'.length), 10);
        // destinationN ids are 1-based intermediate indices; the absolute
        // waypoint index is N (origin is 0). Reject out-of-range indices so a
        // malformed id cannot map to a non-existent waypoint.
        if (Number.isInteger(n) && n >= 1 && n < lastIndex) {
          absolute.push(n);
        }
      }
    }

    return absolute;
  }

  /**
   * Resolve the wire-level `transportMode` string. When the caller passed a
   * narrowed {@link HereRoutingOptions} with `transportMode`, it overrides the
   * base {@link IRoutingOptions.travelMode} mapping.
   */
  private resolveTransportMode(options: IRoutingOptions): string {
    const narrowed = options as HereRoutingOptions;
    if (typeof narrowed.transportMode === 'string') {
      return narrowed.transportMode;
    }
    return mapTravelMode(options.travelMode);
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx. The
   * cause object merges in Retry-After when present by design (no structured retry field).
   */
  private async raiseHttpError(
    response: Response,
    label: string,
  ): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null
        ? { ...(errorBody ?? {}), retryAfter }
        : errorBody;
    return new ConnectorError({
      message: `${label} failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map HERE (HTTP status, body) → canonical {@link ProviderCode}. Per
   * the classification is purely status-driven. the mapping lives
   * per-connector (no shared middleware).
   */
  private mapVendorError(
    httpStatus: number,
    _body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
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
    const base = readHereErrorMessage(body);

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

function buildAvoidFeatures(options: IRoutingOptions): string {
  const avoids: string[] = [];
  if (options.avoidTolls) avoids.push('tollRoad');
  if (options.avoidFerries) avoids.push('ferry');
  if (options.avoidHighways) avoids.push('controlledAccessHighway');
  return avoids.join(',');
}

function readHereErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  // HERE v8 errors: { title, cause, status }.
  const title = obj.title;
  const cause = obj.cause;
  if (typeof title === 'string' && title !== '') {
    if (typeof cause === 'string' && cause !== '') {
      return `${title}: ${cause}`;
    }
    return title;
  }
  if (typeof cause === 'string' && cause !== '') return cause;

  // Fallback: nested { error: { message } } or top-level { message } / { error }.
  const error = obj.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof obj.message === 'string' && obj.message !== '') return obj.message;
  if (typeof error === 'string' && error !== '') return error;

  return null;
}
