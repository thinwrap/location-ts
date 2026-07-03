import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { joinCoords, mergePassthrough } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { MapboxConfig } from './mapbox.config';
import type { MapboxMatrixResponse } from './mapbox.types';

const MATRIX_URL = 'https://api.mapbox.com/directions-matrix/v1/mapbox';

/**
 * Mapbox Matrix v1 connector — per-connector template.
 *
 * GETs `https://api.mapbox.com/directions-matrix/v1/mapbox/{profile}/{coords}`
 * with `access_token`, `sources`, `destinations`, and an annotations invariant
 * forced to `duration,distance`.
 *
 * **Annotations invariant.** Mapbox's default is duration-only, which would
 * leave `distanceMeters` null on every cell and violate the "both distance
 * and duration" guarantee. We set `annotations=duration,distance` AFTER the
 * `_passthrough` merge so a consumer attempt to override it via
 * `_passthrough.query.annotations` is silently overwritten. README documents
 * that to layer in extra annotations (e.g. `congestion`), the consumer must
 * include both built-ins explicitly: `'duration,distance,congestion'`.
 *
 * Result-shape normalization: the vendor's 2D `durations[][]` + `distances[][]`
 * arrays are flattened into `cells[]`. Native meters + seconds (no
 * conversion). `result.raw` exposes the full vendor body for consumer
 * power-use.
 */
export class MapboxMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'mapbox';

  constructor(private config: MapboxConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    // Empty origins/destinations would build a malformed `;`-only path and
    // empty `sources=`/`destinations=` params; fail fast with a typed error.
    if (options.origins.length === 0 || options.destinations.length === 0) {
      throw new ConnectorError({
        message: 'Mapbox Matrix requires non-empty origins and destinations',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage:
          'Mapbox Matrix requires non-empty origins and destinations',
      });
    }

    const profile = this.mapProfile(options.travelMode);
    const allCoords = [...options.origins, ...options.destinations];
    // Reject NaN/non-finite coordinates before they serialize into the URL
    // (out-of-range but finite lat/lng pass through verbatim — thin-wrapper).
    for (const coord of allCoords) {
      assertFiniteCoordinate(coord, 'Mapbox Matrix');
    }
    const coords = joinCoords(allCoords, 'lnglat', ';');

    const originIndices = options.origins.map((_, i) => i);
    const destinationIndices = options.destinations.map(
      (_, i) => i + options.origins.length,
    );

    const url = `${MATRIX_URL}/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
      sources: originIndices.join(';'),
      destinations: destinationIndices.join(';'),
    };

    // Merge passthrough first; the `annotations` invariant is then set AFTER
    // the merge so any consumer attempt to override it via
    // `_passthrough.query.annotations` is silently overwritten. This
    // guarantees `distanceMeters` is populated on every cell.
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
      const errorBody = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const retryAfter = response.headers.get('retry-after');
      const cause =
        retryAfter !== null
          ? { ...(errorBody ?? {}), retryAfter }
          : errorBody;
      throw new ConnectorError({
        message: `Mapbox Matrix failed: ${response.status}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, retryAfter),
        cause,
      });
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxMatrixResponse
      | null;

    // A 2xx with an empty/non-JSON body parses to null; surface a typed
    // ConnectorError instead of letting a raw SyntaxError escape.
    if (data === null) {
      throw new ConnectorError({
        message: 'Mapbox Matrix returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Mapbox Matrix returned a malformed response body',
      });
    }

    // Mapbox returns HTTP 200 with envelope `code !== 'Ok'` for some edge
    // cases (e.g. `NoRoute`, `ProfileNotFound`). Surface as ConnectorError.
    if (data.code !== 'Ok') {
      throw new ConnectorError({
        message: `Mapbox returned code: ${data.code}`,
        statusCode: response.status,
        providerCode: this.mapBodyCode(data.code),
        providerMessage: `Mapbox returned code: ${data.code}`,
        cause: data,
      });
    }

    // 2D-to-flat-cells normalization. Index loop emits every
    // (origin, destination) pair. Native units (meters + seconds).
    const distances = data.distances ?? [];
    const durations = data.durations ?? [];

    // LOC-CP-1 (loc-CR #79/#99): verify the vendor's 2D matrices match the
    // requested origins×destinations dimensions BEFORE flattening. Mapbox
    // returns one row per source and one column per destination; a sparse,
    // asymmetric, or short matrix would otherwise be silently zero-filled by
    // the `?? 0` cell reads below — returning WRONG cells with no signal. We
    // surface a typed ConnectorError instead (mirrors the malformed-body guard
    // above + Google's parseNdjsonElements guard). No 'invalid_response'
    // ProviderCode exists in error.types.ts; 'unknown' is the closest existing
    // value for a malformed provider body.
    assertMatrixDimensions(
      durations,
      distances,
      options.origins.length,
      options.destinations.length,
      data,
    );

    const cells: IMatrixCell[] = [];
    for (let i = 0; i < options.origins.length; i++) {
      for (let j = 0; j < options.destinations.length; j++) {
        cells.push({
          originIndex: i,
          destinationIndex: j,
          distanceMeters: distances[i]?.[j] ?? 0,
          durationSeconds: durations[i]?.[j] ?? 0,
        });
      }
    }

    return { cells, raw: data };
  }

  /**
   * Map (HTTP status, decoded body) → canonical {@link ProviderCode}. Per
   * (per-connector locality).    */
  private mapVendorError(httpStatus: number, _body: unknown): ProviderCode {
    if (httpStatus === 401) return 'auth_failed';
    if (httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    // Mapbox 422 (incl. NoRoute/NoSegment envelopes) → invalid_request. (loc-CR
    // #86 only flagged the prior dead/duplicate ternary; this collapses it to a
    // single return without changing the established mapping.)
    if (httpStatus === 422) return 'invalid_request';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Map a 200-OK envelope `code !== 'Ok'` to ProviderCode. Mapbox occasionally
   * returns HTTP 200 with a non-Ok envelope code such as `NoRoute` or
   * `ProfileNotFound`.
   */
  private mapBodyCode(code: string): ProviderCode {
    switch (code) {
      case 'NoRoute':
      case 'NoSegment':
      case 'InvalidInput':
      case 'ProfileNotFound':
        return 'invalid_request';
      case 'ProcessingError':
        return 'unknown';
      default:
        return 'unknown';
    }
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present. No structured
   * `retryAfterSeconds` field on `ConnectorError`
   * by design.
   */
  private formatProviderMessage(
    body: unknown,
    retryAfter: string | null,
  ): string | null {
    const base = readMapboxMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
  }

  private mapProfile(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'walking';
      case 'cycling':
        return 'cycling';
      default:
        return 'driving';
    }
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
      `Mapbox Matrix returned a matrix that does not match the requested ` +
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

function readMapboxMessage(body: unknown): string | null {
  if (body !== null && typeof body === 'object') {
    const obj = body as { message?: unknown; error?: unknown };
    if (typeof obj.message === 'string' && obj.message !== '') return obj.message;
    if (typeof obj.error === 'string' && obj.error !== '') return obj.error;
  }
  return null;
}
