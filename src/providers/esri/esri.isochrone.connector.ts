import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  closeRing,
  isFiniteNumber,
  isRecord,
  isUsableRing,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
  ringSignedArea,
  toContourGeometry,
  validateIsochroneCap,
} from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import { esriEpochMillis } from './esri.time';
import {
  ESRI_WALKING_DISTANCE_TRAVEL_MODE,
  mapEsriTravelMode,
} from './esri.travel-modes';
import type { EsriServiceAreaResponse } from './esri.types';

type EsriServiceAreaFeature = NonNullable<EsriServiceAreaResponse['saPolygons']>['features'][number];

const SERVICE_AREA_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea';

const MINUTES_TO_SECONDS = 60;
const METERS_PER_KILOMETER = 1000;

/**
 * Largest break ESRI will build a detailed polygon for: "reduced to 15 minutes
 * or 15 miles" for `esriNAOutputPolygonDetailed`, against 300 for the default
 * simplified polygons.
 */
const DETAILED_POLYGON_MAX_SECONDS = 15 * 60;
const DETAILED_POLYGON_MAX_METERS = 24140; // 15 mi, rounded down

/**
 * ESRI (ArcGIS) ServiceArea connector — Isochrone.
 *
 * POSTs form-encoded data to the World ServiceArea `solveServiceArea`
 * endpoint with the center point as an ESRI `facilities` FeatureSet
 * (`{ features: [{ geometry: { x: lng, y: lat, spatialReference: { wkid: 4326 } } }] }`).
 * Dual-auth ({@link EsriConfig} `apiKey` XOR `arcgisToken`) is resolved via
 * {@link resolveEsriBearerToken} and forwarded as the `token` form field.
 *
 * **Values conversion.** `defaultBreaks` is read in the units of the impedance
 * attribute (the service has no break-units parameter). For `type: 'time'`
 * input seconds are divided by 60 into minutes, the unit of the default
 * `TravelTime` / walking `WalkTime` impedance. For `type: 'distance'` input
 * meters are divided by 1000 into kilometers and the impedance is switched to
 * `Kilometers` — as `impedanceAttributeName` for driving, or by sending Esri's
 * "Walking Distance" travel mode for walking, since a travel mode overrides
 * `impedanceAttributeName`.
 *
 * **Polygon detail.** Detailed polygons are requested only while every break is
 * within ESRI's detailed limit (15 minutes / 15 miles); otherwise the
 * service-default simplified polygons, whose limit is 300 minutes / 300 miles.
 *
 * **Travel mode.** Base `'driving'` is the ESRI default; `'walking'` embeds the
 * canonical World "Walking Time" travel-mode object (see
 * {@link mapEsriTravelMode}) — ArcGIS requires a full JSON object, not a name
 * string. ESRI does NOT augment `IsochroneOptionsMap` — narrowed type stays at
 * base.
 *
 * **Auth handling.** Identical to the other ESRI connectors.
 *
 * **Response normalization.** ESRI returns
 * `saPolygons.features[i].geometry.rings: number[][][]` already in `[lng, lat]`
 * order when `outSR=4326`. The rings mix exterior rings (clockwise, by Esri's
 * convention) and holes (counter-clockwise) in no guaranteed order — `rings[0]`
 * may be a hole — so {@link esriRingsToPolygons} classifies them by winding and
 * nests each hole in its exterior. One exterior is a `Polygon`, several a
 * `MultiPolygon`. Each polygon is reported with the caller's value for the
 * `attributes.ToBreak` break it answers.
 *
 * **200-with-error-body quirk.** ArcGIS surfaces app-level failures
 * as 200 + `{ error: { code, message } }`. The connector inspects body on
 * success status and funnels both paths through {@link mapVendorError}.
 *
 * **Cap.** {@link validateIsochroneCap} enforces a 4-value
 * ceiling at the top of `.isochrone`.
 */
export class EsriIsochroneConnector
  extends BaseConnector
  implements IIsochroneConnector
{
  readonly providerId = 'esri';

  constructor(private config: EsriConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async isochrone(options: IIsochroneOptions): Promise<IIsochroneResult> {
    validateIsochroneCap(options);

    const facilities = buildFacilitiesFeatureSet(options.center);

    // `solveServiceArea` has no break-units parameter: `defaultBreaks` is read
    // in the units of the impedance attribute. Time breaks go out in minutes
    // (the default `TravelTime` / walking `WalkTime` impedances are minutes);
    // distance breaks go out in kilometers with a `Kilometers` impedance.
    //
    // ESRI accepts FRACTIONAL minutes/kilometers, so seconds and meters convert
    // without rounding to whole units (whole minutes would turn 30 s into 60 s,
    // and 20 s into an invalid 0). Six decimals strip float noise only
    // (0.000001 min ≈ 60 µs). Each break is remembered against the caller's
    // value: ESRI echoes the break it was sent (7 s goes out as 0.116667 min),
    // and scaling that back would report 7.00002 s.
    const unit = options.type === 'time' ? 60 : METERS_PER_KILOMETER;
    const breakToValue = new Map<number, number>();
    for (const value of options.values) {
      breakToValue.set(Math.round((value / unit) * 1e6) / 1e6, value);
    }
    const breaks = [...breakToValue.keys()].map(formatCoord).join(',');

    const form: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      facilities: JSON.stringify(facilities),
      defaultBreaks: breaks,
      outputPolygons: withinDetailedPolygonLimit(options)
        ? 'esriNAOutputPolygonDetailed'
        : 'esriNAOutputPolygonSimplified',
      returnFacilities: 'false',
      travelDirection: 'esriNATravelDirectionFromFacility',
      outSR: '4326',
    };

    // `undefined` for driving (the service default); the walking mode otherwise.
    const travelMode = mapEsriTravelMode(options.travelMode, 'Isochrone');
    if (options.type === 'distance') {
      if (travelMode !== undefined) {
        // A travel mode overrides `impedanceAttributeName`, so walking needs
        // Esri's "Walking Distance" mode, whose own impedance is Kilometers.
        form.travelMode = JSON.stringify(ESRI_WALKING_DISTANCE_TRAVEL_MODE);
      } else {
        form.impedanceAttributeName = 'Kilometers';
      }
    } else if (travelMode !== undefined) {
      form.travelMode = travelMode;
    }

    // Isochrone has no `trafficMode`, so a departure time is always forwarded,
    // and that is what makes the service area traffic-aware: Esri applies live
    // traffic for a `timeOfDay` within 4 hours of now and typical traffic
    // beyond that, and time-independent speeds when no `timeOfDay` is sent.
    if (options.departureTime) {
      // `IIsochroneOptions.departureTime` is an ISO string; `timeOfDay` takes
      // epoch milliseconds, a UTC instant — which ESRI reads in the facility's
      // local time zone unless `timeOfDayIsUTC` is set.
      form.timeOfDay = esriEpochMillis(options.departureTime, 'Isochrone');
      form.timeOfDayIsUTC = 'true';
    }

    const merged = mergePassthrough(
      form as unknown as Record<string, unknown>,
      {},
      options._passthrough,
    );
    const finalForm: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged.body)) {
      finalForm[key] = stringifyFormValue(value);
    }

    const response = await this.sendPostForm(SERVICE_AREA_URL, finalForm, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | EsriServiceAreaResponse
      | null;

    if (data === null) {
      throw new ConnectorError({
        message: 'ESRI Isochrone returned non-JSON body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'ESRI Isochrone returned non-JSON body',
      });
    }

    if (data.error) {
      const errorBody = data as unknown as Record<string, unknown>;
      throw new ConnectorError({
        message: `ESRI Isochrone failed: ${data.error.message ?? data.error.code}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, null),
        cause: data.error,
      });
    }

    const features = optionalArray(isRecord(data.saPolygons) ? data.saPolygons.features : undefined);
    if (features === null || features.length === 0) {
      throw malformedResponseError('ESRI Isochrone', 'no service-area polygons', response.status, data);
    }

    const contours = features
      .map((entry) => {
        const f = isRecord(entry) ? (entry as unknown as EsriServiceAreaFeature) : null;
        // Rings are in `[lng, lat]` order when outSR=4326. An empty or malformed
        // ring is dropped rather than failing the contour; only a polygon with
        // no usable ring at all describes no area.
        const rawRings: unknown = f?.geometry?.rings;
        const rings = Array.isArray(rawRings) ? rawRings.filter(isUsableRing) : [];
        const toBreak: unknown = f?.attributes?.ToBreak;
        if (!isFiniteNumber(toBreak) || rings.length === 0) {
          throw malformedResponseError(
            'ESRI Isochrone',
            'a polygon has no ToBreak value or no outer ring',
            response.status,
            data,
          );
        }
        const geometry = toContourGeometry(esriRingsToPolygons(rings));
        // The caller's own value for the break ESRI echoes. A break the
        // connector did not send (a passthrough `defaultBreaks`) is converted
        // back to seconds/meters instead, to the millimeter/microsecond the
        // breaks are sent at.
        const value =
          breakToValue.get(toBreak) ??
          (options.type === 'time'
            ? toBreak * MINUTES_TO_SECONDS
            : Math.round(toBreak * METERS_PER_KILOMETER * 1e3) / 1e3);
        return { value, geometry };
      })
      .sort((a, b) => a.value - b.value);

    return { contours, raw: data };
  }

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
      message: `ESRI Isochrone failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map ESRI (HTTP status, decoded body) → canonical {@link ProviderCode}
   * Handles both HTTP-level codes and ESRI's 200-with-error-body
   * via `body.error.code`.
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
      if (
        bodyErrorCode === 498 ||
        bodyErrorCode === 499 ||
        bodyErrorCode === 403
      ) {
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

// --------------------------------------------------------------------------
// Module-private helpers
// --------------------------------------------------------------------------

function buildFacilitiesFeatureSet(center: {
  lat: number;
  lng: number;
}): {
  features: Array<{
    geometry: {
      x: number;
      y: number;
      spatialReference: { wkid: 4326 };
    };
  }>;
} {
  // Reject NaN/non-finite coordinates before they serialize into the
  // FeatureSet (JSON.stringify(NaN) === "null" would silently corrupt the
  // geometry). Out-of-range but finite lat/lng pass through verbatim.
  assertFiniteCoordinate(center, 'ESRI isochrone center');
  return {
    features: [
      {
        geometry: {
          x: center.lng,
          y: center.lat,
          spatialReference: { wkid: 4326 },
        },
      },
    ],
  };
}

/**
 * Whether every break fits ESRI's detailed-polygon limit. Larger breaks are
 * outside what ESRI documents for detailed polygons, so they are requested as
 * the service-default simplified polygons instead.
 */
function withinDetailedPolygonLimit(options: IIsochroneOptions): boolean {
  const max =
    options.type === 'time' ? DETAILED_POLYGON_MAX_SECONDS : DETAILED_POLYGON_MAX_METERS;
  return options.values.every((v) => v <= max);
}

/**
 * Group an Esri polygon's rings into `[exterior, ...holes]` polygons.
 *
 * Esri winds exterior rings clockwise and holes counter-clockwise, and lists
 * them in no guaranteed order, so the winding — not the position — decides what
 * each ring is. A zero-area ring has no winding and is kept as an exterior
 * rather than lost. Each hole goes to the smallest exterior containing its first
 * vertex (the smallest, so a hole inside an island that itself sits in a hole
 * lands on the island), or to the largest exterior when none contains it.
 *
 * With no clockwise ring at all the response is not following Esri's convention;
 * every ring is then read as its own exterior rather than discarded.
 */
function esriRingsToPolygons(rings: number[][][]): number[][][][] {
  const exteriors: Array<{ ring: number[][]; area: number }> = [];
  const holes: number[][][] = [];
  for (const raw of rings) {
    const ring = closeRing(raw);
    const area = ringSignedArea(ring);
    if (area > 0) holes.push(ring);
    else exteriors.push({ ring, area: Math.abs(area) });
  }
  if (exteriors.length === 0) return holes.map((ring) => [ring]);

  const polygons = exteriors.map(({ ring }) => [ring]);
  for (const hole of holes) {
    const [x, y] = hole[0]!;
    let target = -1;
    exteriors.forEach(({ ring, area }, i) => {
      if (!pointInRing(x!, y!, ring)) return;
      if (target === -1 || area < exteriors[target]!.area) target = i;
    });
    if (target === -1) {
      target = 0;
      exteriors.forEach(({ area }, i) => {
        if (area > exteriors[target]!.area) target = i;
      });
    }
    polygons[target]!.push(hole);
  }
  return polygons;
}

/** Even-odd ray cast: whether `(x, y)` lies inside the closed `ring`. */
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) {
      inside = !inside;
    }
  }
  return inside;
}

function stringifyFormValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
