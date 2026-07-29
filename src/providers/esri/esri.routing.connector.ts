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
  encodePolyline,
  invertWaypointPositions,
  mergePassthrough,
} from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import { mapEsriTravelMode, esriTimeAttributeFor } from './esri.travel-modes';
import type {
  EsriRouteFeatureAttributes,
  EsriRouteResponse,
  EsriStopFeatureAttributes,
} from './esri.types';

const ROUTE_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve';
const MINUTES_TO_SECONDS = 60;
/** Only reached if a service reports distance in miles rather than kilometers. */
const METERS_PER_MILE = 1609.344;

/**
 * ESRI (ArcGIS) Route NAServer connector.
 *
 * POSTs form-encoded data to the World Route solve endpoint with an ESRI
 * FeatureSet `stops` payload (`{ features: [{ geometry: { x: lng, y: lat,
 * spatialReference: { wkid: 4326 } } }, ...] }`). Dual-auth ({@link EsriConfig}
 * `apiKey` XOR `arcgisToken`) is resolved via {@link resolveEsriBearerToken}
 * and forwarded as the `token` form field.
 *
 * **ESRI's 200-with-error-body quirk:** ArcGIS REST services frequently
 * return HTTP 200 OK with an `error: { code, message }` body for
 * application-layer failures (invalid token, malformed query, no route
 * found). This connector inspects the body even on success status codes and
 * throws a {@link ConnectorError} for either path — both the `!response.ok`
 * branch AND the `data.error` branch funnel through
 * {@link EsriRoutingConnector.mapVendorError}.
 *
 * Polyline rebuilding is inline: `routes.features[0].geometry.paths` arrives
 * as `[[[lng, lat], ...]]` (ESRI lng-first, NOT polyline-encoded). We flatMap
 * to `LatLng[]` and re-encode via {@link encodePolyline} (Google precision-5
 *). locked this call-site shape.
 *
 * Token lifecycle (~120 min for `arcgisToken`) is consumer-owned (the wrapper holds no state); documented in the per-connector README
 *
 */
export class EsriRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'esri';

  constructor(private config: EsriConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    const waypoints = options.waypoints;
    if (waypoints.length < 2) {
      throw new ConnectorError({
        message: 'ESRI Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'ESRI Routing requires at least two waypoints',
      });
    }

    const stopsFeatureSet = buildStopsFeatureSet(waypoints);

    // Legs come from the `stops` cumulative costs rather than the `directions`
    // output: Esri documents that output as superseded, and its `esriDMT*` maneuver
    // values are not enumerated in the REST reference at all.
    const timeAttribute = esriTimeAttributeFor(options.travelMode);
    const form: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      stops: JSON.stringify(stopsFeatureSet),
      returnRoutes: 'true',
      returnStops: 'true',
      // Explicit because the service default is `true`, so omitting this still
      // ships the whole turn-by-turn payload.
      returnDirections: 'false',
      // Produces the `Cumul_<attr>` fields; no `impedanceAttributeName` required.
      accumulateAttributeNames: `${timeAttribute},Kilometers`,
      // Only `paths` is read; the `...WithMeasure` variant adds an m-value per point.
      outputLines: 'esriNAOutputLineTrueShape',
      outSR: '4326',
    };

    // ESRI findBestSequence optimizes an OPEN route (optionally preserving the
    // first/last stop); it has no closed round-trip mode. Surface the unsupported
    // flag instead of silently returning an open route.
    if (options.isRoundTrip === true) {
      throw new ConnectorError({
        message: 'ESRI route optimization does not support round trips (isRoundTrip)',
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage:
          'ESRI findBestSequence optimizes an open route and cannot return a closed round trip; remove isRoundTrip or use a provider that supports it (e.g. Mapbox/OSRM).',
      });
    }

    if (options.optimize === true) {
      form.findBestSequence = 'true';
      if (options.optimizeFixedOrigin === true) {
        form.preserveFirstStop = 'true';
      }
      if (options.optimizeFixedDestination === true) {
        form.preserveLastStop = 'true';
      }
    }

    const travelMode = mapEsriTravelMode(options.travelMode, 'Routing');
    if (travelMode !== undefined) {
      form.travelMode = travelMode;
    }

    const restrictions = buildRestrictions(options);
    if (restrictions !== '') {
      form.restrictionAttributeNames = restrictions;
    }

    if (options.departureTime) {
      // ESRI accepts epoch milliseconds for `startTime`.
      form.startTime = String(options.departureTime.getTime());
    }

    // Body merge (form fields) + headers merge + query merge. Passthrough.body
    // overlays form fields template; values are stringified to
    // satisfy URLSearchParams.
    const merged = mergePassthrough(
      form as unknown as Record<string, unknown>,
      {},
      options._passthrough,
    );
    const finalForm: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged.body)) {
      finalForm[key] = stringifyFormValue(value);
    }

    const response = await this.sendPostForm(ROUTE_URL, finalForm, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | EsriRouteResponse
      | null;

    // inspect body on success status. ESRI surfaces app-level failures
    // as 200 OK + { error: { code, message } }.
    if (data !== null && typeof data === 'object' && data.error) {
      const errorBody = data as unknown as Record<string, unknown>;
      throw new ConnectorError({
        message: `ESRI Routing failed: ${data.error.message ?? data.error.code}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, null),
        cause: data.error,
      });
    }

    if (data === null) {
      throw new ConnectorError({
        message: 'ESRI Routing returned non-JSON body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'ESRI Routing returned non-JSON body',
      });
    }

    return this.normalizeSuccess(data, waypoints, response.status, options);
  }

  /**
   * Normalize a 2xx ESRI response into an {@link IRoutingResult}: the chosen route
   * is `routes.features[0]`, legs and totals come from the per-stop cumulative
   * costs, and the geometry paths are re-encoded as a precision-5 polyline.
   */
  private normalizeSuccess(
    data: EsriRouteResponse,
    waypoints: LatLng[],
    status: number,
    options: IRoutingOptions,
  ): IRoutingResult {
    const feature = data.routes?.features?.[0];
    if (!feature) {
      // ESRI's OBSERVED no-route path is the in-body `error` envelope handled in
      // `route()` (an unlocated stop), not an empty featureset. This branch is
      // therefore a shape ESRI has not been seen to produce — classify it with
      // the same code as the other five providers so a consumer has exactly one
      // "provider answered, no route" case to branch on.
      throw new ConnectorError({
        message: 'ESRI Routing returned no routes',
        statusCode: status,
        providerCode: 'no_route',
        providerMessage: 'ESRI Routing returned no routes',
        cause: data,
      });
    }

    const attrs: EsriRouteFeatureAttributes = feature.attributes ?? {};

    // Legs and totals share one source, so they always reconcile.
    const cumulative = readCumulativeStopCosts(data.stops?.features);

    // Fallback: a stop that failed to locate carries no cumulative cost, and a
    // service configured without the accumulate attributes returns none at all.
    const totalDistanceMeters =
      cumulative?.totalDistanceMeters ?? readRouteTotalDistanceMeters(attrs);
    const totalDurationSeconds =
      cumulative?.totalDurationSeconds ?? readRouteTotalDurationSeconds(attrs);

    const legs =
      cumulative?.legs ??
      evenSplitLegs(waypoints.length, totalDistanceMeters, totalDurationSeconds);

    // Inline paths → LatLng[] → precision-5 polyline (inline
    // replacement). ESRI `paths` is `[[[lng, lat], ...]]`.
    const allPoints: LatLng[] = (feature.geometry?.paths ?? []).flatMap(
      (path) =>
        path
          .filter(
            (point): point is number[] =>
              Array.isArray(point) && point.length >= 2,
          )
          .map(([lng, lat]) => ({ lat: lat as number, lng: lng as number })),
    );
    const polyline = encodePolyline(allPoints);

    // Optimized routes only. Stops are always fetched now, so without this gate an
    // unoptimized route would report a useless identity permutation. Emitting an
    // ordering for unoptimized calls is a separate decision, for all six providers.
    const waypointOrder =
      options.optimize === true
        ? extractWaypointOrder(data.stops?.features, waypoints.length)
        : undefined;

    return {
      legs,
      totalDistanceMeters,
      totalDurationSeconds,
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
      message: `ESRI Routing failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map ESRI (HTTP status, decoded body) → canonical {@link ProviderCode}.
   *
   * Handles both HTTP-level codes and ESRI's 200-with-error-body case, which
   * arrives via `body.error.code`.
   */
  private mapVendorError(
    httpStatus: number,
    body: Record<string, unknown> | null,
  ): ProviderCode {
    const bodyErrorCode = readBodyErrorCode(body);

    // Precedence fix (Esri 429-precedence): `429 → rate_limited` takes
    // precedence over the body-code → 'unknown' fallthrough, so a genuinely
    // rate-limited response carrying an ambiguous in-body error code still
    // classifies correctly. The 200-with-error-body quirk is preserved: a 200
    // status won't match this check, so in-body mapping still governs there.
    if (httpStatus === 429 || bodyErrorCode === 429) return 'rate_limited';

    if (bodyErrorCode !== null) {
      if (bodyErrorCode === 498 || bodyErrorCode === 499 || bodyErrorCode === 403) {
        return 'auth_failed';
      }
      if (bodyErrorCode === 400 || bodyErrorCode === 404) {
        // ESRI has no distinct code for "no route": an unroutable stop comes back
        // as HTTP 200 with `error.code: 400` and a `details[]` entry naming the
        // stop as **unlocated** (live-verified). `unlocated` is ESRI's own term
        // for a stop it could not snap to the network, so matching it is reading
        // a stated condition, not inferring one — the same bar the OSRM
        // `profile not found` match already meets.
        return hasEsriUnlocatedStop(body) ? 'no_route' : 'invalid_request';
      }
      if (bodyErrorCode === 500) {
        return 'provider_unavailable';
      }
      return 'unknown';
    }

    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design (no structured retry field).
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readEsriErrorMessage(body);

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
 * Build an ESRI FeatureSet for the `stops` form parameter. Each
 * waypoint becomes a Point feature with `geometry.x = lng`, `geometry.y =
 * lat`, and `spatialReference = { wkid: 4326 }` (WGS-84, matching
 * `encodeEsriPaths`'s output convention).
 */
function buildStopsFeatureSet(waypoints: LatLng[]): {
  features: Array<{
    geometry: {
      x: number;
      y: number;
      spatialReference: { wkid: 4326 };
    };
  }>;
} {
  return {
    features: waypoints.map((wp) => {
      // Reject NaN/non-finite coordinates before they serialize into the
      // FeatureSet (JSON.stringify(NaN) === "null" would silently corrupt
      // the geometry). Out-of-range but finite lat/lng pass through verbatim.
      assertFiniteCoordinate(wp, 'ESRI routing stop');
      return {
        geometry: {
          x: wp.lng,
          y: wp.lat,
          spatialReference: { wkid: 4326 },
        },
      };
    }),
  };
}

function buildRestrictions(options: IRoutingOptions): string {
  const restrictions: string[] = [];
  if (options.avoidTolls) restrictions.push('Avoid Toll Roads');
  if (options.avoidFerries) restrictions.push('Avoid Ferries');
  if (options.avoidHighways) restrictions.push('Avoid Limited Access Roads');
  return restrictions.join(',');
}

function stringifyFormValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Per-leg distances/durations and the route totals, from the per-stop cumulative
 * costs. `Cumul_<attribute>` is the cost from the origin *to and including* that
 * stop, so a leg is the difference between consecutive stops and the total is the
 * last value — which is why legs always sum to the totals here.
 *
 * Two things are easy to get wrong:
 *
 * 1. Stops arrive in INPUT order while cumulative costs run along the route, so
 *    they must be sorted by `Sequence`. Without it an optimized route yields
 *    negative legs.
 * 2. The field name carries the active impedance — `Cumul_TravelTime` driving,
 *    `Cumul_WalkTime` walking — so the keys are discovered, not hardcoded.
 *
 * Returns `null` when the values are unusable: fewer than two stops, a stop that
 * failed to locate (`Status != 0` carries no cumulative cost), a non-monotonic
 * sequence, or a service configured without the accumulate attributes.
 */
function readCumulativeStopCosts(
  features: Array<{ attributes: EsriStopFeatureAttributes }> | undefined,
):
  | { legs: IRoutingLeg[]; totalDistanceMeters: number; totalDurationSeconds: number }
  | null {
  if (!Array.isArray(features) || features.length < 2) return null;

  // Sequence is 1-based; sorting by it puts the stops in route order.
  const ordered = features
    .map((f) => f.attributes ?? {})
    .filter((a) => typeof a.Sequence === 'number')
    .sort((a, b) => (a.Sequence as number) - (b.Sequence as number));
  if (ordered.length !== features.length || ordered.length < 2) return null;

  const keys = Object.keys(ordered[0]!).filter((k) => k.startsWith('Cumul_'));
  const distanceKey = keys.find((k) => /Kilometers|Miles$/.test(k));
  const timeKey = keys.find((k) => k !== distanceKey);
  if (distanceKey === undefined || timeKey === undefined) return null;

  const toMeters = distanceKey.endsWith('Miles') ? METERS_PER_MILE : 1000;

  const distances: number[] = [];
  const times: number[] = [];
  for (const a of ordered) {
    const d = a[distanceKey as `Cumul_${string}`];
    const t = a[timeKey as `Cumul_${string}`];
    // Not located / not reached: no cumulative cost, so every later diff is wrong.
    if (typeof d !== 'number' || typeof t !== 'number') return null;
    if (a.Status !== undefined && a.Status !== 0) return null;
    distances.push(d * toMeters);
    times.push(t * MINUTES_TO_SECONDS);
  }

  const legs: IRoutingLeg[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const distanceMeters = distances[i]! - distances[i - 1]!;
    const durationSeconds = times[i]! - times[i - 1]!;
    // Cumulative costs never decrease, so a negative diff means the order is wrong.
    if (distanceMeters < 0 || durationSeconds < 0) return null;
    legs.push({ distanceMeters, durationSeconds });
  }

  return {
    legs,
    totalDistanceMeters: distances[distances.length - 1]!,
    totalDurationSeconds: times[times.length - 1]!,
  };
}

/**
 * The route's total distance in meters. Matched by shape, because the attribute is
 * suffixed with the active distance attribute (`Total_Kilometers` / `Total_Miles`)
 * and this service emits no `Total_Length`.
 */
function readRouteTotalDistanceMeters(attrs: EsriRouteFeatureAttributes): number {
  if (typeof attrs.Total_Length === 'number') return attrs.Total_Length;
  if (typeof attrs.Total_Kilometers === 'number') return attrs.Total_Kilometers * 1000;
  const record = attrs as Record<string, unknown>;
  const miles = record.Total_Miles;
  if (typeof miles === 'number') return miles * METERS_PER_MILE;
  return 0;
}

/**
 * The route's total duration in seconds. Same shape-based match: any `Total_*` that
 * is not a distance attribute is the time one, in minutes (`Total_TravelTime`
 * driving, `Total_WalkTime` walking, `Total_TruckTravelTime` for a truck mode).
 */
function readRouteTotalDurationSeconds(attrs: EsriRouteFeatureAttributes): number {
  if (typeof attrs.Total_Time === 'number') return attrs.Total_Time * MINUTES_TO_SECONDS;
  const record = attrs as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('Total_')) continue;
    if (/Kilometers|Miles|Length/.test(key)) continue;
    if (typeof value === 'number') return value * MINUTES_TO_SECONDS;
  }
  return 0;
}

/** Even split of the totals, used when per-stop cumulative costs are unavailable. */
function evenSplitLegs(
  waypointCount: number,
  totalDistanceMeters: number,
  totalDurationSeconds: number,
): IRoutingLeg[] {
  const numLegs = Math.max(1, waypointCount - 1);
  return Array.from({ length: numLegs }, () => ({
    distanceMeters: totalDistanceMeters / numLegs,
    durationSeconds: totalDurationSeconds / numLegs,
  }));
}

/**
 * Derive the optimized visiting sequence when `findBestSequence=true` was
 * requested. ESRI returns the `stops` FeatureSet (`returnStops=true`) in INPUT
 * order, each stop carrying a 1-based `Sequence` = its position in the
 * optimized route. Invert to the canonical `waypointOrder` = full visiting
 * sequence of INPUT indices (`order[Sequence - 1] = inputIndex`). Returns
 * `undefined` when the sequence data is absent, incomplete, or malformed.
 */
function extractWaypointOrder(
  stops: Array<{ attributes: EsriStopFeatureAttributes }> | undefined,
  totalStops: number,
): number[] | undefined {
  if (!stops) return undefined;

  // ESRI `Sequence` is 1-based; the shared helper expects 0-based visit
  // positions. Non-numeric values are forwarded verbatim so the helper rejects
  // them (it also enforces the length, range, and no-duplicates checks).
  const positions = stops.map((stop) => {
    const seq = stop?.attributes?.Sequence;
    return typeof seq === 'number' ? seq - 1 : seq;
  });

  return invertWaypointPositions(positions, totalStops);
}

/**
 * Whether an ESRI error body reports a stop it could not locate on the network.
 *
 * Live-verified shape: HTTP 200 with
 * `{ error: { code: 400, message: 'Unable to complete operation.',
 *   details: ['Location "Location 1" in "Stops" is unlocated. …'] } }`.
 * The `details[]` array is the only place the cause appears.
 */
function hasEsriUnlocatedStop(body: Record<string, unknown> | null): boolean {
  if (body === null) return false;
  const errorField = body.error;
  if (errorField === null || typeof errorField !== 'object') return false;
  const details = (errorField as { details?: unknown }).details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (detail) => typeof detail === 'string' && /unlocated/i.test(detail),
  );
}

function readBodyErrorCode(body: Record<string, unknown> | null): number | null {
  if (body === null) return null;
  const errorField = body.error;
  if (errorField === null || typeof errorField !== 'object') return null;
  const code = (errorField as Record<string, unknown>).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code !== '' && !Number.isNaN(Number(code))) {
    return Number(code);
  }
  return null;
}

function readEsriErrorMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  const errorField = body.error;
  if (errorField !== null && typeof errorField === 'object') {
    const errObj = errorField as Record<string, unknown>;
    const msg = errObj.message;
    if (typeof msg === 'string' && msg !== '') return msg;
    const code = errObj.code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code !== '') return code;
  }
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof errorField === 'string' && errorField !== '') return errorField;
  return null;
}
