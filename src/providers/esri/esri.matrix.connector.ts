import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { isRecord, malformedResponseError, mergePassthrough } from '../../utils';
import { validateMatrixOptions } from '../../utils/validate-options';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import { isTrafficRequested } from '../../utils/traffic';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import { ESRI_MATRIX_ACCUMULATE_ATTRIBUTES } from './esri.defaults';
import {
  ESRI_TIME_ATTRIBUTE_NAMES,
  esriTimeAttributeFor,
  esriTravelModeForm,
} from './esri.travel-modes';
import { esriEpochMillis } from './esri.time';
import type { EsriODMatrixResponse } from './esri.types';

const MATRIX_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/OriginDestinationCostMatrix/NAServer/OriginDestinationCostMatrix_World/solveODCostMatrix';

const MINUTES_TO_SECONDS = 60;
const KILOMETERS_TO_METERS = 1000;

/**
 * ESRI (ArcGIS) OD Cost Matrix connector — shares the ESRI Routing
 * FeatureSet + dual-auth + 200-with-error-body patterns.
 *
 * POSTs form-encoded data to the World OD Cost Matrix `solveODCostMatrix`
 * endpoint with ESRI FeatureSet payloads for `origins` and `destinations`
 * (each waypoint → feature with `geometry: { x: lng, y: lat,
 * spatialReference: { wkid: 4326 } }`). Dual-auth ({@link EsriConfig} `apiKey`
 * XOR `arcgisToken`) is resolved via {@link resolveEsriBearerToken} and
 * forwarded as the `token` form field.
 *
 * **ESRI's 200-with-error-body quirk:** ArcGIS REST services
 * frequently return HTTP 200 OK with an `error: { code, message }` body for
 * application-layer failures (invalid token, malformed query, no route
 * found). This connector inspects the body even on success status codes and
 * throws a {@link ConnectorError} for either path — both the `!response.ok`
 * branch AND the `data.error` branch funnel through
 * {@link EsriMatrixConnector.mapVendorError}.
 *
 * **Result-shape normalization:** With `outputType=esriNAODOutputSparseMatrix`
 * the response carries the matrix as `odCostMatrix` — a sparse object keyed by
 * 1-based origin OID, each mapping 1-based destination OID to a cost-value
 * array ordered per `costAttributeNames` (`[TravelTime(min), Kilometers(km)]`).
 * The connector flattens to `IMatrixCell[]`, converting minutes → seconds and
 * kilometers → meters. A fallback over the `odLines.features[]` FeatureSet
 * (`esriNAODOutputStraightLines`) preserves parity.
 *
 * Token lifecycle (~120 min for `arcgisToken`) is consumer-owned (the wrapper
 * holds no state); documented in the per-connector README.
 *
 * Error mapping + Retry-After parsing live inline; no shared middleware.
 * Retry-After surfacing: parsed seconds in `providerMessage` + raw header in
 * `cause.retryAfter` (no structured `retryAfterSeconds` field on
 * `ConnectorError`).
 */
export class EsriMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'esri';

  constructor(private config: EsriConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    validateMatrixOptions(options, 'ESRI Matrix');
    if (options.origins.length === 0 || options.destinations.length === 0) {
      throw new ConnectorError({
        message:
          'ESRI Matrix requires at least one origin and one destination',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage:
          'ESRI Matrix requires at least one origin and one destination',
      });
    }

    const originsFeatureSet = buildPointFeatureSet(options.origins);
    const destinationsFeatureSet = buildPointFeatureSet(options.destinations);

    const form: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      origins: JSON.stringify(originsFeatureSet),
      destinations: JSON.stringify(destinationsFeatureSet),
      // Sparse matrix keyed by origin/destination OID. Impedance TravelTime
      // (minutes) is auto-included in the output; accumulate Kilometers (km) so
      // each cell array is [TravelTime, Kilometers].
      outputType: 'esriNAODOutputSparseMatrix',
      impedanceAttributeName: 'TravelTime',
      accumulateAttributeNames: ESRI_MATRIX_ACCUMULATE_ATTRIBUTES.join(','),
      outSR: '4326',
    };

    Object.assign(
      form,
      esriTravelModeForm(options.travelMode, 'Matrix', buildRestrictions(options)),
    );

    // Esri applies traffic whenever a `timeOfDay` is sent ("To use traffic in
    // the analysis, set impedanceAttributeName to TravelTime, and assign a
    // timeOfDay value"): `now` is live, an explicit time within 4 hours of now
    // is live and typical beyond that. Without one, `TravelTime` falls back to
    // time-independent speeds — the model `'none'` promises — so under `'none'`
    // the time is never sent, and with traffic but no time `now` is sent.
    // Validated even when dropped: an invalid Date is a caller bug either way.
    // A passthrough `timeOfDay` still wins (merged below).
    const timeOfDay =
      options.departureTime !== undefined
        ? esriEpochMillis(options.departureTime, 'Matrix')
        : undefined;
    if (isTrafficRequested(options.trafficMode)) {
      // `solveODCostMatrix` has no `startTime` parameter — its departure is
      // `timeOfDay` (epoch ms), read in the origins' local time zone unless
      // `timeOfDayIsUTC` is set. Esri forces it to true for `now`.
      form.timeOfDay = timeOfDay ?? 'now';
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

    const response = await this.sendPostForm(MATRIX_URL, finalForm, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | EsriODMatrixResponse
      | null;

    // inspect body on success status. ESRI surfaces app-level failures
    // as 200 OK + { error: { code, message } }.
    if (data !== null && typeof data === 'object' && data.error) {
      const errorBody = data as unknown as Record<string, unknown>;
      throw new ConnectorError({
        message: `ESRI Matrix failed: ${data.error.message ?? data.error.code}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, null),
        cause: data.error,
      });
    }

    if (data === null) {
      throw new ConnectorError({
        message: 'ESRI Matrix returned non-JSON body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'ESRI Matrix returned non-JSON body',
      });
    }

    return this.normalizeSuccess(
      data,
      options.origins.length,
      options.destinations.length,
      response.status,
      esriTimeAttributeFor(options.travelMode),
    );
  }

  /**
   * Normalize a 2xx ESRI response into an {@link IMatrixResult}. Flattens the
   * sparse `odCostMatrix` object (origin OID → dest OID → cost values) into
   * `cells[]`, converting ESRI minutes → seconds and kilometers → meters. Falls
   * back to the `odLines.features[]` straight-lines FeatureSet.
   */
  private normalizeSuccess(
    data: EsriODMatrixResponse,
    numOrigins: number,
    numDestinations: number,
    status: number,
    timeAttribute: string,
  ): IMatrixResult {
    const cells: IMatrixCell[] = [];

    if (data.odCostMatrix !== undefined) {
      if (!isRecord(data.odCostMatrix)) {
        throw malformedResponseError('ESRI Matrix', '`odCostMatrix` is not an object', status, data);
      }
      const odm = data.odCostMatrix as NonNullable<EsriODMatrixResponse['odCostMatrix']>;
      const attrOrder = odm.costAttributeNames ?? ['TravelTime', 'Kilometers'];
      // The impedance column is named after the active travel mode: driving
      // reports `TravelTime`, walking reports `WalkTime` (the WALK travelMode
      // object overrides the requested `impedanceAttributeName`). Locate it by
      // the known time-impedance names rather than assuming `TravelTime`, else a
      // walking matrix silently decodes every duration as 0.
      let timeIdx = -1;
      for (const name of ESRI_TIME_ATTRIBUTE_NAMES) {
        const i = attrOrder.indexOf(name);
        if (i >= 0) {
          timeIdx = i;
          break;
        }
      }
      const distIdx = attrOrder.indexOf('Kilometers');
      // A column this decoder does not recognise (a future travel mode's
      // impedance, e.g. `TruckTravelTime`, or a passthrough-changed
      // accumulation) would otherwise decode every cell as 0 — a plausible,
      // silently wrong matrix. Refuse it instead, naming the columns received.
      if (timeIdx < 0 || distIdx < 0) {
        throw costColumnError(
          `ESRI Matrix returned unrecognised cost columns [${attrOrder.join(', ')}]; ` +
            `expected one of ${ESRI_TIME_ATTRIBUTE_NAMES.join('/')} and Kilometers`,
          attrOrder,
          data,
          status,
        );
      }

      // Sparse shape: every key except `costAttributeNames` is a 1-based origin
      // OID whose value maps 1-based dest OID → cost-value array. Map OIDs to
      // 0-based indices via `- 1`; an OID that is non-finite, < 1, or beyond the
      // requested dimensions would yield a negative/misaligned/out-of-range
      // cell, so reject the whole response. 'unknown' is the closest existing
      // ProviderCode for a malformed provider body (no 'invalid_response').
      for (const [originKey, row] of Object.entries(odm)) {
        if (originKey === 'costAttributeNames') continue;
        if (row === undefined || Array.isArray(row) || typeof row !== 'object') {
          throw matrixOidError(data, status);
        }
        const originOID = Number(originKey);
        if (
          !Number.isFinite(originOID) ||
          originOID < 1 ||
          originOID > numOrigins
        ) {
          throw matrixOidError(data, status);
        }
        for (const [destKey, values] of Object.entries(row)) {
          const destOID = Number(destKey);
          if (
            !Number.isFinite(destOID) ||
            destOID < 1 ||
            destOID > numDestinations
          ) {
            throw matrixOidError(data, status);
          }
          const decoded = decodeCostCell(values, timeIdx, distIdx);
          if (decoded === null) {
            throw costColumnError(
              `ESRI Matrix cell ${originKey}→${destKey} has no numeric value for every cost column ` +
                `[${attrOrder.join(', ')}]`,
              attrOrder,
              data,
              status,
            );
          }
          const { timeMinutes, distanceKm } = decoded;
          cells.push({
            originIndex: originOID - 1,
            destinationIndex: destOID - 1,
            distanceMeters: distanceKm * KILOMETERS_TO_METERS,
            durationSeconds: timeMinutes * MINUTES_TO_SECONDS,
          });
        }
      }

      // A SPARSE matrix (Esri omits unreachable pairs) is returned as-is rather
      // than erroring the whole call — each cell carries its origin/destination
      // index, so the consumer can tell which pairs are present — the same
      // cell-omission rule as Mapbox/OSRM/HERE/Google. The OID-range guards
      // above still reject a genuinely malformed/misaligned response.
      return { cells, raw: data };
    }

    if (isRecord(data.odLines) && data.odLines.features !== undefined) {
      if (!Array.isArray(data.odLines.features)) {
        throw malformedResponseError('ESRI Matrix', '`odLines.features` is not a list', status, data);
      }
      // Straight-lines FeatureSet: 1-based OriginID/DestinationID; minutes + km.
      for (const f of data.odLines.features as NonNullable<EsriODMatrixResponse['odLines']>['features']) {
        if (!isRecord(f) || !isRecord(f.attributes)) throw matrixOidError(data, status);
        const attrs = f.attributes;
        // OIDs are 1-based, mapped to 0-based indices via `- 1`. An ID of 0,
        // undefined, non-finite or beyond the requested dimensions would yield
        // a negative/NaN/out-of-range index and a silently misaligned cell —
        // the same bounds the sparse path enforces. Reject the whole response
        // rather than emit a wrong cell.
        if (
          !Number.isInteger(attrs.OriginID) ||
          !Number.isInteger(attrs.DestinationID) ||
          attrs.OriginID < 1 ||
          attrs.DestinationID < 1 ||
          attrs.OriginID > numOrigins ||
          attrs.DestinationID > numDestinations
        ) {
          throw matrixOidError(data, status);
        }
        // The total is suffixed with the active impedance — `Total_WalkTime` on
        // a walking matrix — and a missing one must not decode as 0.
        const timeKey = `Total_${timeAttribute}` as 'Total_TravelTime' | 'Total_WalkTime';
        const minutes = attrs[timeKey];
        const km = attrs.Total_Kilometers;
        if (typeof minutes !== 'number' || typeof km !== 'number') {
          throw costColumnError(
            `ESRI Matrix odLines feature ${attrs.OriginID}→${attrs.DestinationID} lacks ` +
              `${timeKey} or Total_Kilometers`,
            Object.keys(attrs),
            data,
            status,
          );
        }
        cells.push({
          originIndex: attrs.OriginID - 1,
          destinationIndex: attrs.DestinationID - 1,
          distanceMeters: km * KILOMETERS_TO_METERS,
          durationSeconds: minutes * MINUTES_TO_SECONDS,
        });
      }

      // A SPARSE FeatureSet (Esri omits unreachable pairs) is returned as-is
      // rather than erroring the whole call — each cell is indexed, matching the
      // other providers' cell-omission semantics. The OID-range guards above still
      // reject a genuinely malformed/misaligned response.
      return { cells, raw: data };
    }

    throw new ConnectorError({
      message: 'ESRI Matrix response missing odCostMatrix and odLines payload',
      statusCode: status,
      providerCode: 'unknown',
      providerMessage:
        'ESRI Matrix response missing odCostMatrix and odLines payload',
      cause: data,
    });
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
      message: `ESRI Matrix failed: ${response.status}`,
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
 * Build an ESRI FeatureSet for the `origins`/`destinations` form parameters.
 * Each waypoint becomes a Point feature with `geometry.x = lng`,
 * `geometry.y = lat`, and `spatialReference = { wkid: 4326 }` (WGS-84,
 * matching `encodeEsriPaths`'s output convention and the ESRI Routing stops
 * FeatureSet).
 */
function buildPointFeatureSet(points: LatLng[]): {
  features: Array<{
    geometry: {
      x: number;
      y: number;
      spatialReference: { wkid: 4326 };
    };
  }>;
} {
  return {
    features: points.map((p) => {
      // Reject NaN/non-finite coordinates before they serialize into the
      // FeatureSet (JSON.stringify(NaN) === "null" would silently corrupt
      // the geometry). Out-of-range but finite lat/lng pass through verbatim.
      assertFiniteCoordinate(p, 'ESRI Matrix point');
      return {
        geometry: {
          x: p.lng,
          y: p.lat,
          spatialReference: { wkid: 4326 },
        },
      };
    }),
  };
}

function buildRestrictions(options: IMatrixOptions): string[] {
  return options.avoidTolls ? ['Avoid Toll Roads'] : [];
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
 * Decode a single sparse cell's cost-value array. Values are ordered per
 * `costAttributeNames`; `timeIdx`/`distIdx` locate the time column (minutes)
 * and `Kilometers` (km) within it. Returns `null` for a cell too short for its
 * columns or holding a non-numeric value: reporting 0 there would be a
 * plausible, silently wrong cell.
 */
function decodeCostCell(
  values: unknown,
  timeIdx: number,
  distIdx: number,
): { timeMinutes: number; distanceKm: number } | null {
  if (!Array.isArray(values)) return null;
  const timeMinutes: unknown = values[timeIdx];
  const distanceKm: unknown = values[distIdx];
  if (typeof timeMinutes !== 'number' || typeof distanceKm !== 'number') return null;
  return { timeMinutes, distanceKm };
}

/**
 * The typed error for a cost payload whose columns cannot be decoded. `cause`
 * carries the column names received, so the caller can see what Esri sent
 * without digging through `raw`.
 */
function costColumnError(
  message: string,
  costAttributeNames: readonly string[],
  data: EsriODMatrixResponse,
  status: number,
): ConnectorError {
  return new ConnectorError({
    message,
    statusCode: status,
    providerCode: 'unknown',
    providerMessage: message,
    cause: { costAttributeNames, raw: data },
  });
}

/**
 * Build the typed {@link ConnectorError} raised when an ESRI matrix payload
 * carries an OID (sparse origin/dest key or `odLines`
 * OriginID/DestinationID) that is non-finite, non-positive, or beyond the
 * requested dimensions — any of which would map to a negative, NaN, or
 * out-of-range 0-based cell index. `providerCode: 'unknown'` is the closest
 * existing value for a malformed provider body.
 */
function matrixOidError(
  data: EsriODMatrixResponse,
  status: number,
): ConnectorError {
  const message =
    'ESRI Matrix returned a non-positive, out-of-range, or non-finite OID; ' +
    'cannot map to a 0-based cell index';
  return new ConnectorError({
    message,
    statusCode: status,
    providerCode: 'unknown',
    providerMessage: message,
    cause: data,
  });
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
