import type { Polygon } from 'geojson';
import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { mergePassthrough, validateIsochroneCap } from '../../utils';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import type { EsriServiceAreaResponse } from './esri.types';

const SERVICE_AREA_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea';

const MINUTES_TO_SECONDS = 60;

/**
 * ESRI (ArcGIS) ServiceArea connector — Isochrone.
 *
 * POSTs form-encoded data to the World ServiceArea `solveServiceArea`
 * endpoint with the center point as an ESRI `facilities` FeatureSet
 * (`{ features: [{ geometry: { x: lng, y: lat, spatialReference: { wkid: 4326 } } }] }`).
 * Dual-auth ({@link EsriConfig} `apiKey` XOR `arcgisToken`) is resolved via
 * {@link resolveEsriBearerToken} and forwarded as the `token` form field
 * *
 * **Values conversion.** For `type: 'time'` input seconds are divided
 * by 60 (round to nearest) into `defaultBreaks` minutes — ESRI's native unit
 * for `esriDriveTimeUnitsMinutes`. For `type: 'distance'` input meters are
 * passed through into `defaultBreaks` with `esriDriveDistanceUnitsMeters`.
 *
 * **Travel mode.** Base `'driving'` is the ESRI default; `'walking'`
 * maps to `'Walking Time'`. ESRI does NOT augment `IsochroneOptionsMap` —
 * narrowed type stays at base.
 *
 * **Auth handling.** Identical to the other ESRI connectors.
 *
 * **Response normalization.** ESRI returns
 * `saPolygons.features[i].geometry.rings: number[][][]` already in `[lng, lat]`
 * order when `outSR=4326`. v1.0 takes only the outer ring (`rings[0]`) and
 * converts the `attributes.ToBreak` value back to the input unit (minutes →
 * seconds when `type: 'time'`).
 *
 * **200-with-error-body quirk.** ArcGIS surfaces app-level failures
 * as 200 + `{ error: { code, message } }`. The connector inspects body on
 * success status and funnels both paths through {@link mapVendorError}.
 *
 * **Cap.** {@link validateIsochroneCap} enforces a 4-value
 * ceiling at the top of `.isochrone`.
 *
 * v1.0 ignores `rings[1+]` holes; documented in the per-connector README.
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

    // ESRI native units: minutes for time, meters for distance.
    let breaks: string;
    let breakUnits: string;
    if (options.type === 'time') {
      breaks = options.values.map((v) => Math.round(v / 60)).join(',');
      breakUnits = 'esriDriveTimeUnitsMinutes';
    } else {
      breaks = options.values.join(',');
      breakUnits = 'esriDriveDistanceUnitsMeters';
    }

    const form: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      facilities: JSON.stringify(facilities),
      defaultBreaks: breaks,
      breakUnits,
      outputPolygons: 'esriNAOutputPolygonDetailed',
      returnFacilities: 'false',
      travelDirection: 'esriNATravelDirectionFromFacility',
      outSR: '4326',
    };

    const travelMode = mapTravelMode(options.travelMode);
    if (travelMode !== undefined) {
      form.travelMode = travelMode;
    }

    if (options.departureTime) {
      // `IIsochroneOptions.departureTime` is an ISO string (the isochrone channel
      // forwards it as a query/form value; cf. Mapbox/HERE/TomTom). ESRI's
      // `timeOfDay` takes epoch milliseconds, so parse the ISO string here. (The
      // ESRI Matrix sibling reads a `Date` because `IMatrixOptions.departureTime`
      // is `Date` — a deliberate per-channel interface difference, not a bug.)
      form.timeOfDay = String(Date.parse(options.departureTime));
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

    const contours = (data.saPolygons?.features ?? [])
      .map((f) => {
        // `rings[0]` is the outer ring in `[lng, lat]` order when outSR=4326.
        const rings = f.geometry.rings;
        const outerRing = rings[0] ?? [];
        const polygon: Polygon = {
          type: 'Polygon',
          coordinates: [outerRing],
        };
        // ESRI returns the break value in the unit we requested. Convert back
        // to the caller's input unit so `value` matches `IIsochroneOptions.values`.
        const value =
          options.type === 'time'
            ? f.attributes.ToBreak * MINUTES_TO_SECONDS
            : f.attributes.ToBreak;
        return { value, geometry: polygon };
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

function mapTravelMode(
  mode?: 'driving' | 'walking',
): string | undefined {
  switch (mode) {
    case 'walking':
      return 'Walking Time';
    default:
      return undefined;
  }
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
