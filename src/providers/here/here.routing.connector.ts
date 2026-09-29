import { BaseConnector } from '../../base/base.connector';
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
  decodeFlexPolyline,
  encodePolyline,
  isCompleteWaypointOrder,
  isFiniteNumber,
  isRecord,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
} from '../../utils';
import { validateRoutingOptions } from '../../utils/validate-options';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import { toIsoSeconds } from '../../utils/datetime';
import { isTrafficRequested } from '../../utils/traffic';
import type { HereConfig } from './here.config';
import { HERE_ROUTING_RETURN } from './here.defaults';
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
    validateRoutingOptions(options, 'HERE Routing');
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

    // `isRoundTrip` is absent by design — the guard above already threw for it.
    const useOptimization =
      options.optimize === true ||
      options.optimizeFixedOrigin === true ||
      options.optimizeFixedDestination === true;

    let orderedWaypoints: LatLng[] = waypoints;
    let waypointOrder: number[] | undefined;

    if (useOptimization && waypoints.length > 2) {
      const sequence = await this.callFindSequence(waypoints, options);
      // The returned sequence must be a complete permutation of [0..N-1] before
      // it can be used to reorder waypoints; otherwise `waypoints[i]` may be
      // undefined or a waypoint may be dropped/duplicated. HERE is the one
      // connector that throws rather than omitting the ordering, because the
      // sequence also drives the waypoint order of the follow-up /routes call.
      if (!isCompleteWaypointOrder(sequence, waypoints.length)) {
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
      return: HERE_ROUTING_RETURN.join(','),
      routingMode: 'fast',
      origin: `${formatCoord(first.lat)},${formatCoord(first.lng)}`,
      destination: `${formatCoord(last.lat)},${formatCoord(last.lng)}`,
    };

    // HERE applies live traffic whenever `departureTime` is omitted (it assumes
    // "now"), and a traffic-aware request is billed at the Time-Aware Routing
    // rate instead of the basic Car/Bicycle/Pedestrian rate. HERE's price list
    // names the two ways to stay on the basic rate: `departureTime=any` or
    // `traffic[mode]=disabled`. These are defaults only — `_passthrough.query`
    // is merged over them and can re-enable traffic.
    Object.assign(baseQuery, hereRoutesTrafficQuery(options));

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
    if (!isRecord(data)) {
      throw new ConnectorError({
        message: 'HERE Routing returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Routing returned a malformed response body',
        cause: data,
      });
    }
    const routes = optionalArray(data.routes);
    if (routes === null) {
      throw malformedResponseError('HERE Routing', '`routes` is not a list', response.status, data);
    }
    const route = routes[0] as HereRouteResponse['routes'][number] | undefined | null;
    if (route === undefined) {
      // Live-verified: HERE answers an unroutable request with HTTP 200,
      // `routes: []`, and a critical entry in `notices[]` (e.g.
      // `couldNotMatchOrigin`). Surface the notice text so the caller sees WHY
      // without having to dig through `cause`.
      const notice = readHereNotice(data);
      const providerMessage =
        notice !== null
          ? `HERE Routing returned no routes: ${notice}`
          : 'HERE Routing returned no routes';
      throw new ConnectorError({
        message: providerMessage,
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage,
        cause: data,
      });
    }

    if (!isRecord(route)) {
      throw malformedResponseError('HERE Routing', 'the first route is not an object', response.status, data);
    }

    // Every section must be an object carrying the requested summary: a
    // missing length/duration would otherwise be summed as 0 into a plausible,
    // wrong leg.
    const sections = optionalArray(route.sections);
    if (
      sections === null ||
      sections.some(
        (sec) =>
          !isRecord(sec) ||
          !isRecord(sec.summary) ||
          !isFiniteNumber(sec.summary.length) ||
          !isFiniteNumber(sec.summary.duration),
      )
    ) {
      throw malformedResponseError(
        'HERE Routing',
        'a section has no summary length/duration',
        response.status,
        data,
      );
    }
    assertRouteHasLegs(sections.length, waypoints.length, 'HERE Routing', data, response.status);

    // HERE ships `baseDuration` inside the `summary` block already requested, so
    // the opt-in costs nothing extra here — it only gates whether the field is
    // surfaced, keeping the normalized shape identical across providers.
    const wantsBaseDuration =
      options.include?.includes('durationWithoutTraffic') === true;

    const typedSections = sections as HereRouteSection[];
    const allCoords: LatLng[] = [];
    for (const section of typedSections) {
      if (typeof section.polyline === 'string' && section.polyline !== '') {
        allCoords.push(...decodeFlexPolyline(section.polyline));
      }
    }

    const legs = groupSectionsIntoLegs(typedSections, waypoints.length).map((group) => {
      const leg: IRoutingLeg = {
        distanceMeters: group.reduce((sum, s) => sum + s.summary.length, 0),
        durationSeconds: group.reduce((sum, s) => sum + s.summary.duration, 0),
      };
      // Only when every section of the leg carried it, so a partial response
      // omits the field rather than under-reporting it.
      if (
        wantsBaseDuration &&
        group.every((s) => typeof s.summary?.baseDuration === 'number')
      ) {
        leg.durationWithoutTrafficSeconds = group.reduce(
          (sum, s) => sum + (s.summary?.baseDuration as number),
          0,
        );
      }
      return leg;
    });

    const totalDistanceMeters = legs.reduce((s, l) => s + l.distanceMeters, 0);
    const totalDurationSeconds = legs.reduce((s, l) => s + l.durationSeconds, 0);

    // Summed from the sections HERE returned, matching how the traffic-aware
    // totals above are derived — and only when every section carried the value,
    // so a partial response omits the field rather than under-reporting it.
    const baseDurations = legs.map((l) => l.durationWithoutTrafficSeconds);
    const totalDurationWithoutTrafficSeconds =
      wantsBaseDuration &&
      baseDurations.length > 0 &&
      baseDurations.every((d): d is number => typeof d === 'number')
        ? baseDurations.reduce((a, b) => a + b, 0)
        : undefined;

    return {
      legs,
      totalDistanceMeters,
      totalDurationSeconds,
      polyline: encodePolyline(allCoords),
      ...(totalDurationWithoutTrafficSeconds !== undefined
        ? { totalDurationWithoutTrafficSeconds }
        : {}),
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
      // `Type;TransportModes;TrafficMode;RouteFeature1,RouteFeature2`, per the
      // Waypoints Sequence `mode` grammar.
      //
      // Route features: the same avoids the follow-up /routes call applies, so
      // the sequence is optimized over the roads the route will actually use —
      // otherwise the order and the route disagree. `-3` is HERE's "strictly
      // avoid", and the features are one comma-joined segment.
      //
      // `traffic:` — enabling traffic on findsequence2 is BILLABLE, so it
      // follows the explicit `trafficMode` opt-in and stays disabled by default.
      mode: [
        'fastest',
        transportMode,
        `traffic:${isTrafficRequested(options.trafficMode) ? 'enabled' : 'disabled'}`,
        ...buildSequenceRouteFeatures(options),
      ].join(';'),
    };

    if (options.departureTime) {
      // HERE findsequence2 documents the departure-time param as `departure`
      // (ISO 8601); it silently ignores an unrecognized `departureTime`, so
      // traffic-aware sequencing would never take effect.
      baseQuery.departure = toIsoSeconds(options.departureTime);
    }

    // Merge `_passthrough` (query + headers) into this leg too, so a consumer
    // can tune the sequence request (e.g. `improveFor`, `mode` overrides). The
    // connector query (including the per-intermediate destinationN keys) is the
    // base; passthrough.query overrides on collision.
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
    if (!isRecord(data)) {
      throw new ConnectorError({
        message: 'HERE findsequence2 returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE findsequence2 returned a malformed response body',
        cause: data,
      });
    }
    const sequenceResult = Array.isArray(data.results) ? data.results[0] : undefined;
    if (!isRecord(sequenceResult) || !Array.isArray(sequenceResult.waypoints)) {
      // The legacy WPS endpoint also reports a rejected request as HTTP 200 with
      // `{ results: null, errors: [...], responseCode: '400' }`, so the reason
      // arrives here rather than through `raiseHttpError`. Surface it.
      const reason = readHereErrorMessage(data);
      const providerMessage =
        reason !== null
          ? `HERE findsequence2 returned no sequence: ${reason}`
          : 'HERE findsequence2 returned no sequence';
      throw new ConnectorError({
        message: providerMessage,
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage,
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
   * Map HERE (HTTP status, body) → canonical {@link ProviderCode}. The
   * classification is purely status-driven, and the mapping lives
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

/**
 * Read the first critical `notices[]` entry from a HERE routing response.
 *
 * Live-verified shape: an unroutable request returns HTTP 200 with
 * `{ routes: [], notices: [{ title, code, severity }] }` — e.g.
 * `couldNotMatchOrigin` / severity `critical`. The notice is the only statement
 * of *why*, so it is woven into `providerMessage`; the full array stays in
 * `cause`.
 */
function readHereNotice(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const notices = (data as { notices?: unknown }).notices;
  if (!Array.isArray(notices)) return null;
  for (const notice of notices) {
    if (notice === null || typeof notice !== 'object') continue;
    const n = notice as { code?: unknown; title?: unknown };
    const code = typeof n.code === 'string' && n.code !== '' ? n.code : null;
    const title = typeof n.title === 'string' && n.title !== '' ? n.title : null;
    if (code !== null && title !== null) return `${title} (${code})`;
    if (title !== null) return title;
    if (code !== null) return code;
  }
  return null;
}

type HereRouteSection = HereRouteResponse['routes'][number]['sections'][number];

/**
 * Group HERE route sections into one group per requested leg.
 *
 * A section is not a leg. HERE splits the route at every waypoint *and* at every
 * implicit change of mode — a ferry or car-shuttle crossing becomes its own
 * `TransitSection` inside an otherwise driving route — so mapping sections 1:1
 * would report a two-waypoint trip with a ferry as three legs. What marks a
 * requested stop is `arrival.place.waypoint`: present for each `via`, absent for
 * origin/destination and for stops the router added itself. A leg therefore
 * closes after a section arriving at a waypoint, and after the final section.
 *
 * A response carrying no `waypoint` markers at all but exactly one section per
 * leg keeps the 1:1 mapping.
 */
function groupSectionsIntoLegs(
  sections: HereRouteSection[],
  waypointCount: number,
): HereRouteSection[][] {
  const hasMarkers = sections.some(
    (s) => typeof s.arrival?.place?.waypoint === 'number',
  );
  if (!hasMarkers && sections.length === waypointCount - 1) {
    return sections.map((s) => [s]);
  }

  const groups: HereRouteSection[][] = [];
  let current: HereRouteSection[] = [];
  sections.forEach((section, i) => {
    current.push(section);
    const atWaypoint = typeof section.arrival?.place?.waypoint === 'number';
    if (atWaypoint || i === sections.length - 1) {
      groups.push(current);
      current = [];
    }
  });
  return groups;
}

/**
 * The `/v8/routes` departure/traffic parameters for the caller's `trafficMode`.
 *
 * - `'traffic'` (or its alias `'live'`): HERE's own behaviour — the caller's
 *   `departureTime` if given, otherwise nothing, which HERE reads as "now"
 *   with live traffic.
 * - unset / `'none'` without a time: `departureTime=any`, which drops dynamic
 *   traffic but keeps long-term closures in effect.
 * - unset / `'none'` with a time: `traffic[mode]=disabled` instead, plus the
 *   caller's `departureTime` when it came from the options. `any` would discard
 *   the time; HERE's `disabled` also ignores long-term closures, a trade-off the
 *   README documents.
 *
 * A time set through `_passthrough.query` counts as "with a time": a passthrough
 * `departureTime` would replace `any` and put the request back on live traffic
 * (and the Time-Aware rate), and HERE rejects `departureTime=any` combined with
 * `arrivalTime` with HTTP 400. A passthrough `departureTime=any` is the caller
 * asking for `any` itself, so it keeps the closure-preserving default.
 */
function hereRoutesTrafficQuery(options: IRoutingOptions): Record<string, string> {
  const departureTime = options.departureTime?.toISOString();
  if (isTrafficRequested(options.trafficMode)) {
    return departureTime !== undefined ? { departureTime } : {};
  }
  if (departureTime !== undefined) {
    return { departureTime, 'traffic[mode]': 'disabled' };
  }
  const passthroughQuery = options._passthrough?.query;
  if (
    (passthroughQuery?.departureTime !== undefined && passthroughQuery.departureTime !== 'any') ||
    passthroughQuery?.arrivalTime !== undefined
  ) {
    return { 'traffic[mode]': 'disabled' };
  }
  return { departureTime: 'any' };
}

/**
 * The findsequence2 `mode` route-feature segment for the avoid flags, or no
 * segment at all. HERE's road features are `tollroad`, `motorway`, `boatFerry`,
 * `railFerry`, `tunnel` and `dirtRoad`; a ferry avoid covers both ferry kinds,
 * matching `/routes`' single `ferry` feature.
 */
function buildSequenceRouteFeatures(options: IRoutingOptions): string[] {
  const features: string[] = [];
  if (options.avoidTolls === true) features.push('tollroad:-3');
  if (options.avoidHighways === true) features.push('motorway:-3');
  if (options.avoidFerries === true) features.push('boatFerry:-3', 'railFerry:-3');
  return features.length > 0 ? [features.join(',')] : [];
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

  // findsequence2 is the legacy WPS shape — no `title`/`cause`, just
  // `{ results: null, errors: ['Bad Format for Date and Time: …'],
  //    responseCode: '400' }`. Without this the one statement of *why* is
  // dropped and the caller sees a bare "failed: 400".
  const errors = readHereErrorList(obj.errors);
  if (errors !== null) return errors;

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

/** Join the non-empty strings of a WPS `errors[]` array, or `null` if there are none. */
function readHereErrorList(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const messages = errors.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
  return messages.length > 0 ? messages.join('; ') : null;
}
