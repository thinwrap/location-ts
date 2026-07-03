import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { joinCoords, mergePassthrough } from '../../utils';
import type { OsrmConfig } from './osrm.config';
import type { OsrmTableResponse } from './osrm.types';

/**
 * OSRM Matrix connector — `/table/v1` endpoint for self-hosted
 * OSRM. Mirrors the {@link OsrmRoutingConnector} for `baseUrl`
 * validation, pre-flight checks, and the per-connector error mapping. Mirrors
 * {@link MapboxMatrixConnector} for the `annotations=duration,
 * distance` invariant.
 *
 * **HTTP shape.** `GET <baseUrl>/table/v1/{profile}/{coords}?annotations=
 * duration,distance&sources={origin_indices}&destinations={dest_indices}`.
 * `{coords}` is `lng,lat;lng,lat;...` of origins followed by destinations;
 * `sources`/`destinations` are zero-indexed semicolon-separated indices into
 * that combined list.
 *
 * **`baseUrl` required.** Same as the constructor throws
 * synchronously when `baseUrl` is omitted or empty. The public OSRM demo
 * server is intentionally NOT used as a default.
 *
 * **Pre-flight validation.** OSRM does not natively model traffic or
 * tolls. Pre-flight checks raise typed {@link ConnectorError} with
 * `statusCode: null`:
 *   - `'unsupported_field'`  — `departureTime` set.
 *   - `'unsupported_option'` — `avoidTolls` set.
 *
 * `IMatrixOptions` has no `avoidFerries`/`avoidHighways` (those live on
 * {@link IRoutingOptions} per the locked types), so pre-flight here
 * is two checks rather than the four in Routing.
 *
 * **Annotations invariant.** OSRM's default `/table` response is duration-only
 * (no distances). To keep the "both distance and duration" guarantee,
 * we force `annotations=duration,distance` AFTER the `_passthrough` merge.
 * A consumer attempting to override via `_passthrough.query.annotations` is
 * silently overwritten; README documents that to layer extra annotations the
 * consumer must include both built-ins explicitly.
 *
 * **No auth surface.** Consumers needing auth front their OSRM
 * instance with a reverse proxy. Reverse-proxy 401/429 responses are surfaced
 * verbatim as `auth_failed`/`rate_limited`.
 *
 * **Result-shape normalization.** OSRM's `durations[][]` +
 * `distances[][]` 2D arrays (origin-major) are flattened into the canonical
 * flat `cells[]` shape; native units (meters + seconds, no conversion). Null
 * cells in the vendor body are coerced to 0.
 *
 * **In-body status codes.** OSRM may return HTTP 200 with
 * `body.code !== 'Ok'` for `NoTable`, `InvalidQuery`, `InvalidOptions`. These
 * raise {@link ConnectorError} with `providerCode: 'invalid_request'`.
 *
 * Travel-mode mapping uses the OSRM-standard names `'driving'/'walking'/
 * 'cycling'` (consistent with OSRM Routing and the PHP sibling). Consumers must
 * verify their OSRM build has the requested profile compiled.
 */
export class OsrmMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'osrm';

  constructor(private config: OsrmConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
    // required baseUrl. Throw synchronously before any HTTP.
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

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    // pre-flight validation runs synchronously before any HTTP call.
    this.validateOsrmCompat(options);

    // P11 (#31, #91): empty origins/destinations would build an invalid
    // `/table/v1/{profile}/` URL with an empty coord segment + empty
    // `sources`/`destinations`. Reject locally with a clear error rather than
    // surfacing an opaque vendor 400/404 (matches ESRI's explicit guard).
    if (options.origins.length === 0 || options.destinations.length === 0) {
      throw new ConnectorError({
        message: 'OSRM Matrix requires at least one origin and one destination',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage:
          'OSRM Matrix requires at least one origin and one destination',
      });
    }

    const profile = mapProfile(options.travelMode);
    const allCoords = [...options.origins, ...options.destinations];
    // OSRM coordinates: `lng,lat;lng,lat;...` (note OSRM's lng,lat order).
    const coords = joinCoords(allCoords, 'lnglat', ';');

    const originIndices = options.origins.map((_, i) => i);
    const destinationIndices = options.destinations.map(
      (_, i) => i + options.origins.length,
    );

    const url = `${this.config.baseUrl}/table/v1/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      sources: originIndices.join(';'),
      destinations: destinationIndices.join(';'),
    };

    // Merge passthrough first; the `annotations` invariant is then set AFTER
    // the merge so any consumer attempt to override it via
    // `_passthrough.query.annotations` is silently overwritten. This
    // guarantees `distanceMeters` is populated on every cell — OSRM's default
    // is duration-only.
    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const finalQuery: Record<string, string> = {
      ...merged.query,
      annotations: 'duration,distance',
    };

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: finalQuery,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    // #108: guard the success-path body parse — a truncated/non-JSON 200
    // body must surface as a typed error, not an unwrapped SyntaxError.
    const data = (await response.json().catch(() => null)) as
      | OsrmTableResponse
      | null;

    // OSRM in-body status codes trigger typed errors even on HTTP 200.
    if (data === null || data.code !== 'Ok') {
      throw this.mapInBodyError(data ?? {});
    }

    // 2D-to-flat-cells normalization (origin-major). Index loop emits
    // every (origin, destination) pair. Native units (meters + seconds).
    const durations = data.durations ?? [];
    const distances = data.distances ?? [];

    // LOC-CP-1 (loc-CR #79/#99): verify the vendor's 2D matrices match the
    // requested origins×destinations dimensions BEFORE flattening. OSRM returns
    // one row per source and one column per destination; a sparse, asymmetric,
    // or short matrix would otherwise be silently zero-filled by the `?? 0`
    // cell reads below — returning WRONG cells with no signal. We surface a
    // typed ConnectorError instead (mirrors the `data.code !== 'Ok'` guard
    // above). No 'invalid_response' ProviderCode exists in error.types.ts;
    // 'unknown' is the closest existing value for a malformed provider body.
    assertMatrixDimensions(
      durations,
      distances,
      options.origins.length,
      options.destinations.length,
      data,
    );

    const cells: IMatrixCell[] = [];
    for (let oi = 0; oi < options.origins.length; oi++) {
      for (let di = 0; di < options.destinations.length; di++) {
        cells.push({
          originIndex: oi,
          destinationIndex: di,
          durationSeconds: durations[oi]?.[di] ?? 0,
          distanceMeters: distances[oi]?.[di] ?? 0,
        });
      }
    }

    return { cells, raw: data };
  }

  /**
   * Pre-flight validation raising typed {@link ConnectorError}
   * with `statusCode: null` for OSRM-incompatible inputs. Runs at the top of
   * `.matrix()` before any HTTP work.
   *
   * Unlike {@link OsrmRoutingConnector.validateOsrmCompat}, only two checks:
   * `IMatrixOptions` has no `avoidFerries`/`avoidHighways` fields per the
   * locked types. Order: `departureTime` first, then `avoidTolls`.
   */
  private validateOsrmCompat(options: IMatrixOptions): void {
    if (options.departureTime !== undefined) {
      throw new ConnectorError({
        message: 'OSRM does not support departureTime',
        statusCode: null,
        providerCode: 'unsupported_field',
        providerMessage: 'OSRM does not support departureTime',
      });
    }

    if (options.avoidTolls === true) {
      throw new ConnectorError({
        message: 'OSRM does not support avoidTolls',
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage: 'avoidTolls is not supported by OSRM',
      });
    }
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx HTTP
   * responses. Surfaces Retry-After in `providerMessage` and `cause`
   * by design (no structured retry
   * field). Vanilla OSRM has no auth + no rate-limiting; consumer reverse
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
      message: `OSRM matrix failed: ${response.status}`,
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
   * {@link ConnectorError}. OSRM occasionally returns HTTP 200 with a
   * non-Ok envelope code such as `NoTable`, `InvalidQuery`, `InvalidOptions`.
   */
  private mapInBodyError(body: {
    code?: string;
    message?: string;
  }): ConnectorError {
    const code = typeof body.code === 'string' ? body.code : '';
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : '';

    let providerCode: ProviderCode;
    switch (code) {
      case 'NoTable':
      case 'InvalidQuery':
      case 'InvalidOptions':
        providerCode = 'invalid_request';
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
 * Map base {@link IMatrixOptions.travelMode} to an OSRM profile name.
 *
 * these use the OSRM-standard names `driving / walking /
 * cycling` — consistent with OSRM Routing and PHP Story
 * 3.18. Consumers are responsible for verifying that their OSRM build has the
 * requested profile compiled.
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

/**
 * LOC-CP-1 (loc-CR #79/#99): guard that the vendor's `durations`/`distances`
 * 2D arrays cover the full requested origins×destinations grid before the
 * row-major flatten. Throws a typed {@link ConnectorError} (`providerCode:
 * 'unknown'`, the closest existing value for a malformed provider body) when
 * either matrix has too few rows or any row is shorter than the requested
 * destination stride — the cases where `?? 0` would silently fabricate cells.
 * The full vendor body is preserved on `cause` per the repo convention.
 */
function assertMatrixDimensions(
  durations: (number | null)[][],
  distances: (number | null)[][],
  numOrigins: number,
  numDestinations: number,
  raw: unknown,
): void {
  const dimensionsOk =
    durations.length >= numOrigins &&
    distances.length >= numOrigins &&
    durations
      .slice(0, numOrigins)
      .every((row) => Array.isArray(row) && row.length >= numDestinations) &&
    distances
      .slice(0, numOrigins)
      .every((row) => Array.isArray(row) && row.length >= numDestinations);

  if (!dimensionsOk) {
    const message =
      `OSRM matrix returned a table that does not match the requested ` +
      `${numOrigins}×${numDestinations} dimensions`;
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'unknown',
      providerMessage: message,
      cause: raw,
    });
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
