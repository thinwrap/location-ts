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
import { encodePolyline, mergePassthrough } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import type {
  EsriDirectionStepAttributes,
  EsriRouteFeatureAttributes,
  EsriRouteResponse,
} from './esri.types';

const ROUTE_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve';
const MINUTES_TO_SECONDS = 60;
const STOP_MANEUVER = 'esriDMTStop';

/**
 * ESRI (ArcGIS) Route NAServer connector — per-connector template.
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

    const form: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      stops: JSON.stringify(stopsFeatureSet),
      returnRoutes: 'true',
      returnDirections: 'true',
      directionsLengthUnits: 'esriNAUMeters',
      directionsOutputType: 'esriDOTComplete',
      outputLines: 'esriNAOutputLineTrueShapeWithMeasure',
      outSR: '4326',
    };

    if (options.optimize === true) {
      form.findBestSequence = 'true';
      if (options.optimizeFixedOrigin === true) {
        form.preserveFirstStop = 'true';
      }
      if (options.optimizeFixedDestination === true) {
        form.preserveLastStop = 'true';
      }
    }

    const travelMode = mapTravelMode(options.travelMode);
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

    return this.normalizeSuccess(data, waypoints, response.status);
  }

  /**
   * Normalize a 2xx ESRI response into an {@link IRoutingResult}. Resolves
   * `routes.features[0]` (the chosen route), extracts totals from its
   * attributes, reconstructs per-leg distance/duration from the directions
   * FeatureSet, and re-encodes the geometry paths as a precision-5 polyline.
   */
  private normalizeSuccess(
    data: EsriRouteResponse,
    waypoints: LatLng[],
    status: number,
  ): IRoutingResult {
    const feature = data.routes?.features?.[0];
    if (!feature) {
      throw new ConnectorError({
        message: 'ESRI Routing returned no routes',
        statusCode: status,
        providerCode: 'unknown',
        providerMessage: 'ESRI Routing returned no routes',
        cause: data,
      });
    }

    const attrs: EsriRouteFeatureAttributes = feature.attributes ?? {};

    // Prefer Total_Length (meters, requested via directionsLengthUnits=
    // esriNAUMeters). Fall back to Total_Kilometers * 1000 for older
    // brownfield responses.
    const totalDistanceMeters =
      typeof attrs.Total_Length === 'number'
        ? attrs.Total_Length
        : typeof attrs.Total_Kilometers === 'number'
          ? attrs.Total_Kilometers * 1000
          : 0;

    const totalTimeMinutes =
      typeof attrs.Total_Time === 'number'
        ? attrs.Total_Time
        : typeof attrs.Total_TravelTime === 'number'
          ? attrs.Total_TravelTime
          : 0;
    const totalDurationSeconds = totalTimeMinutes * MINUTES_TO_SECONDS;

    const legs = reconstructLegs(
      data.directions,
      waypoints,
      totalDistanceMeters,
      totalDurationSeconds,
    );

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

    const waypointOrder = extractWaypointOrder(attrs, waypoints.length);

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
   * Map ESRI (HTTP status, decoded body) → canonical {@link ProviderCode}
   * Handles both HTTP-level codes and ESRI's 200-with-error-body
   * case via `body.error.code`. */
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
        return 'invalid_request';
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

function mapTravelMode(
  mode?: 'driving' | 'walking' | 'cycling',
): string | undefined {
  switch (mode) {
    case 'walking':
      return 'Walking';
    case 'cycling':
      // ESRI World Route does not ship a public cycling mode. Per the baseline
      // schema-coherence decision (consistent with ESRI Matrix), fail fast with
      // a typed error rather than silently degrading to driving.
      throw new ConnectorError({
        message: 'ESRI Routing does not support travelMode "cycling"',
        statusCode: null,
        providerCode: 'unsupported_travel_mode',
        providerMessage: 'ESRI Routing does not support travelMode "cycling"',
      });
    default:
      return undefined;
  }
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
 * Reconstruct per-leg distances/durations from the ESRI directions FeatureSet
 * Each direction step carries `length` (meters when
 * `directionsLengthUnits=esriNAUMeters`) and `time` (minutes). Legs are
 * delimited by `maneuverType=esriDMTStop` steps.
 *
 * Falls back to even-split of totals when directions are absent (parity with
 * the PHP sibling).
 */
function reconstructLegs(
  directions: EsriRouteResponse['directions'] | undefined,
  waypoints: LatLng[],
  totalDistance: number,
  totalDuration: number,
): IRoutingLeg[] {
  const numLegs = Math.max(1, waypoints.length - 1);
  const directionSet = directions?.[0]?.features;

  if (!Array.isArray(directionSet) || directionSet.length === 0) {
    return Array.from({ length: numLegs }, () => ({
      distanceMeters: totalDistance / numLegs,
      durationSeconds: totalDuration / numLegs,
    }));
  }

  const legs: IRoutingLeg[] = [];
  let accDist = 0;
  let accTime = 0;
  let passedFirstStop = false;

  for (const step of directionSet) {
    const stepAttrs: EsriDirectionStepAttributes = step.attributes ?? {
      length: 0,
      time: 0,
    };
    const isStop = stepAttrs.maneuverType === STOP_MANEUVER;

    if (isStop) {
      if (!passedFirstStop) {
        // First esriDMTStop is the route origin — start accumulating after it.
        passedFirstStop = true;
        accDist = 0;
        accTime = 0;
        continue;
      }
      legs.push({
        distanceMeters: accDist,
        durationSeconds: accTime * MINUTES_TO_SECONDS,
      });
      accDist = 0;
      accTime = 0;
      continue;
    }

    if (!passedFirstStop) continue;

    accDist += typeof stepAttrs.length === 'number' ? stepAttrs.length : 0;
    accTime += typeof stepAttrs.time === 'number' ? stepAttrs.time : 0;
  }

  // Flush remainder when the directions stream did not end on a stop step.
  if (accDist > 0 || accTime > 0) {
    legs.push({
      distanceMeters: accDist,
      durationSeconds: accTime * MINUTES_TO_SECONDS,
    });
  }

  if (legs.length === 0) {
    return Array.from({ length: numLegs }, () => ({
      distanceMeters: totalDistance / numLegs,
      durationSeconds: totalDuration / numLegs,
    }));
  }

  return legs;
}

/**
 * Extract the reordered waypoint sequence when `findBestSequence=true` was
 * requested. ESRI may surface it in `routes.features[0].attributes.Stops`
 * (comma-separated input indices). Returns `undefined` when not present.
 */
function extractWaypointOrder(
  attrs: EsriRouteFeatureAttributes,
  totalStops: number,
): number[] | undefined {
  const stopsAttr = attrs.Stops;
  if (typeof stopsAttr !== 'string' || stopsAttr === '') return undefined;

  const order: number[] = [];
  for (const piece of stopsAttr.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n)) order.push(n);
  }

  return order.length === totalStops ? order : undefined;
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
