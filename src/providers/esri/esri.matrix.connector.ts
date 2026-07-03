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
import { mergePassthrough } from '../../utils';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import type { EsriODMatrixResponse } from './esri.types';

const MATRIX_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/OriginDestinationCostMatrix/NAServer/OriginDestinationCostMatrix_World/solveODCostMatrix';

const MINUTES_TO_SECONDS = 60;

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
 * **Result-shape normalization:** The modern synchronous response
 * carries the matrix as `odCostMatrix.costMatrix.values` — a row-major 2-D
 * array (rows = origins, cols = destinations). Each cell is either a scalar
 * (single cost attribute) or a `[time, distance]` tuple when both
 * `Total_Time` and `Total_Distance` are requested via
 * `outputType=esriNAODOutputSparseMatrix` + `attributeParameterValues`.
 * The connector flattens to `IMatrixCell[]` and converts ESRI minutes to
 * seconds. A fallback over the legacy `odLines.features[]`
 * FeatureSet shape preserves brownfield parity.
 *
 * Token lifecycle (~120 min for `arcgisToken`) is consumer-owned (the wrapper holds no state); documented in the per-connector README
 *
 *
 * per-connector locality: error mapping + Retry-After parsing live
 * inline; no shared middleware. Retry-After surfacing: parsed seconds in
 * `providerMessage` + raw header in `cause.retryAfter` by design (no structured `retryAfterSeconds`
 * field on `ConnectorError`).
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
      // Sparse matrix with both Total_Time + Total_Distance.
      outputType: 'esriNAODOutputSparseMatrix',
      impedanceAttributeName: 'Total_Time',
      // Request both attributes so each cell can carry [time, distance].
      accumulateAttributeNames: 'Total_Time,Total_Distance',
      outSR: '4326',
    };

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
    );
  }

  /**
   * Normalize a 2xx ESRI response into an {@link IMatrixResult}. Flattens
   * the 2-D `odCostMatrix.costMatrix.values` array into `cells[]`,
   * converting ESRI minutes to seconds. Falls back to the
   * legacy `odLines.features[]` shape for brownfield parity.
   */
  private normalizeSuccess(
    data: EsriODMatrixResponse,
    numOrigins: number,
    numDestinations: number,
    status: number,
  ): IMatrixResult {
    const cells: IMatrixCell[] = [];

    if (data.odCostMatrix?.costMatrix?.values !== undefined) {
      const values = data.odCostMatrix.costMatrix.values;
      const attrOrder = data.odCostMatrix.costAttributeNames ?? [
        'Total_Time',
        'Total_Distance',
      ];
      const timeIdx = attrOrder.indexOf('Total_Time');
      const distIdx = attrOrder.indexOf('Total_Distance');

      // LOC-CP-1 (loc-CR #79/#99): verify the 2D `values` array matches the
      // requested origins×destinations dimensions BEFORE flattening. A sparse,
      // asymmetric, or short matrix would otherwise silently emit fewer/wrong
      // cells with no signal. We surface a typed ConnectorError instead
      // (mirrors the missing-payload guard below). No 'invalid_response'
      // ProviderCode exists in error.types.ts; 'unknown' is the closest
      // existing value for a malformed provider body.
      const valuesOk =
        values.length >= numOrigins &&
        values
          .slice(0, numOrigins)
          .every(
            (row) => Array.isArray(row) && row.length >= numDestinations,
          );
      if (!valuesOk) {
        throw matrixDimensionError(numOrigins, numDestinations, data, status);
      }

      for (let i = 0; i < values.length; i++) {
        const row = values[i] ?? [];
        for (let j = 0; j < row.length; j++) {
          const cell = row[j];
          const { timeMinutes, distanceMeters } = decodeCostCell(
            cell,
            timeIdx,
            distIdx,
          );
          cells.push({
            originIndex: i,
            destinationIndex: j,
            distanceMeters,
            durationSeconds: timeMinutes * MINUTES_TO_SECONDS,
          });
        }
      }
      return { cells, raw: data };
    }

    if (data.odLines?.features !== undefined) {
      // Legacy `odLines` FeatureSet: 1-based OIDs.
      for (const f of data.odLines.features) {
        const attrs = f.attributes;
        // LOC-CP-1 (loc-CR #101): ESRI's legacy OIDs are 1-based, so this path
        // maps them to 0-based indices via `- 1`. An OID of 0, undefined, or
        // non-finite would yield a negative/NaN index and a silently misaligned
        // (or out-of-range) cell. Reject the whole response rather than emit a
        // wrong cell — 'unknown' is the closest existing ProviderCode for a
        // malformed provider body.
        if (
          !Number.isFinite(attrs.OriginOID) ||
          !Number.isFinite(attrs.DestinationOID) ||
          attrs.OriginOID < 1 ||
          attrs.DestinationOID < 1
        ) {
          const message =
            'ESRI Matrix odLines returned a non-positive or non-finite OID; ' +
            'cannot map to a 0-based cell index';
          throw new ConnectorError({
            message,
            statusCode: status,
            providerCode: 'unknown',
            providerMessage: message,
            cause: data,
          });
        }
        cells.push({
          originIndex: attrs.OriginOID - 1,
          destinationIndex: attrs.DestinationOID - 1,
          distanceMeters: attrs.Total_Distance,
          durationSeconds: attrs.Total_Time * MINUTES_TO_SECONDS,
        });
      }

      // LOC-CP-1 (loc-CR #100/#101): the legacy FeatureSet omits unreachable
      // pairs, so verify the emitted cells cover the full requested grid before
      // returning a silently sparse matrix.
      const expectedCount = numOrigins * numDestinations;
      if (cells.length < expectedCount) {
        throw matrixDimensionError(numOrigins, numDestinations, data, status);
      }

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
 * Build an ESRI FeatureSet for the `origins`/`destinations` form parameters
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
    features: points.map((p) => ({
      geometry: {
        x: p.lng,
        y: p.lat,
        spatialReference: { wkid: 4326 },
      },
    })),
  };
}

function mapTravelMode(
  mode?: 'driving' | 'walking' | 'cycling',
): string | undefined {
  switch (mode) {
    case 'walking':
      return 'Walking';
    case 'cycling':
      // ESRI World OD Cost Matrix does not ship a public cycling mode. Per the
      // baseline schema-coherence decision, fail fast with a typed error rather
      // than silently degrading to driving.
      throw new ConnectorError({
        message: 'ESRI Matrix does not support travelMode "cycling"',
        statusCode: null,
        providerCode: 'unsupported_travel_mode',
        providerMessage: 'ESRI Matrix does not support travelMode "cycling"',
      });
    default:
      return undefined;
  }
}

function buildRestrictions(options: IMatrixOptions): string {
  const restrictions: string[] = [];
  if (options.avoidTolls) restrictions.push('Avoid Toll Roads');
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
 * Decode a single `costMatrix.values[i][j]` cell. ESRI may emit a scalar
 * (single cost attribute) or an `[a, b]` tuple (multiple attributes ordered
 * per `costAttributeNames`). When only a scalar is present, we attribute it
 * to whichever of `Total_Time`/`Total_Distance` the impedance was requested
 * against (Time is the impedance default).
 */
function decodeCostCell(
  cell: number | [number, number] | undefined,
  timeIdx: number,
  distIdx: number,
): { timeMinutes: number; distanceMeters: number } {
  if (Array.isArray(cell)) {
    const timeMinutes =
      timeIdx >= 0 && typeof cell[timeIdx] === 'number' ? cell[timeIdx]! : 0;
    const distanceMeters =
      distIdx >= 0 && typeof cell[distIdx] === 'number' ? cell[distIdx]! : 0;
    return { timeMinutes, distanceMeters };
  }
  if (typeof cell === 'number') {
    return { timeMinutes: cell, distanceMeters: 0 };
  }
  return { timeMinutes: 0, distanceMeters: 0 };
}

/**
 * LOC-CP-1 (loc-CR #79/#99/#100/#101): build the typed {@link ConnectorError}
 * raised when an ESRI matrix payload (modern `costMatrix.values` or legacy
 * `odLines.features`) does not cover the full requested origins×destinations
 * grid. `providerCode: 'unknown'` is the closest existing value for a malformed
 * provider body; the full vendor body is preserved on `cause`.
 */
function matrixDimensionError(
  numOrigins: number,
  numDestinations: number,
  data: EsriODMatrixResponse,
  status: number,
): ConnectorError {
  const message =
    `ESRI Matrix returned a matrix that does not match the requested ` +
    `${numOrigins}×${numDestinations} dimensions`;
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
