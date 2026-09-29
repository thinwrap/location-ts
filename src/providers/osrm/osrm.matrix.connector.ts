import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { isFiniteNumber, joinCoords, malformedResponseError, mergePassthrough } from '../../utils';
import { validateMatrixOptions } from '../../utils/validate-options';
import { validateOsrmBaseUrl } from './osrm.base-url';
import type { OsrmConfig } from './osrm.config';
import { OSRM_TABLE_ANNOTATIONS } from './osrm.defaults';
import { classifyOsrmEnvelopeCode } from './osrm.envelope';
import { resolveOsrmExcludes } from './osrm.exclude';
import type { OsrmTableResponse } from './osrm.types';

/**
 * OSRM Matrix connector — `/table/v1` endpoint for self-hosted
 * OSRM. Mirrors the {@link OsrmRoutingConnector} for `baseUrl`
 * validation, pre-flight checks, and the per-connector error mapping. Mirrors
 * {@link MapboxMatrixConnector} for the `annotations=duration,
 * distance` default.
 *
 * **HTTP shape.** `GET <baseUrl>/table/v1/{profile}/{coords}?annotations=
 * duration,distance&sources={origin_indices}&destinations={dest_indices}`.
 * `{coords}` is `lng,lat;lng,lat;...` of origins followed by destinations;
 * `sources`/`destinations` are zero-indexed semicolon-separated indices into
 * that combined list.
 *
 * **`baseUrl` required.** Validated at the top of `.matrix()`, like the routing
 * connector: a missing, empty or schemeless `baseUrl` rejects with
 * `invalid_request` before any request. The public OSRM demo server is
 * intentionally NOT used as a default.
 *
 * **Pre-flight validation.** OSRM honours `avoidTolls` only on a build
 * compiled with the `toll` exclude class. The pre-flight check raises a typed
 * {@link ConnectorError} with `statusCode: null`:
 *   - `'unsupported_option'` — `avoidTolls` set without `'toll'` declared in
 *     `OsrmConfig.supportedExcludeClasses`; when it is declared, `/table` gets
 *     `exclude=toll`, the same rule as the routing connector.
 *
 * **Traffic and departure time.** OSRM has no time parameter and no traffic
 * model at request time, so `trafficMode: 'traffic'` is ignored and
 * `departureTime` with it; under `'none'` a departure time has no effect by
 * definition. Neither is rejected.
 *
 * `IMatrixOptions` has no `avoidFerries`/`avoidHighways` (those live on
 * {@link IRoutingOptions} per the locked types), so only `avoidTolls` applies.
 *
 * **Annotations default.** OSRM's default `/table` response is duration-only
 * (no distances), so the connector asks for both
 * ({@link OSRM_TABLE_ANNOTATIONS}). It is set before the `_passthrough` merge
 * like every other default, so `_passthrough.query.annotations` replaces it; a
 * list missing either value fails the dimension check and raises `unknown`.
 *
 * **No auth surface.** Consumers needing auth front their OSRM
 * instance with a reverse proxy. Reverse-proxy 401/429 responses are surfaced
 * verbatim as `auth_failed`/`rate_limited`.
 *
 * **Result-shape normalization.** OSRM's `durations[][]` +
 * `distances[][]` 2D arrays (origin-major) are flattened into the canonical
 * flat `cells[]` shape; native units (meters + seconds, no conversion). A null
 * cell (unroutable pair) is omitted from `cells[]`, never coerced to 0.
 *
 * **Envelope codes.** A non-Ok `code` — on a 4xx, where OSRM normally sends
 * it, or on a 2xx — is classified like the routing connector's: `NoSegment`
 * (and `NoTable`, documented as "No route found") → `no_route`,
 * `InvalidQuery`/`InvalidOptions`/`InvalidValue` → `invalid_request`,
 * `NotImplemented` → `unsupported_option`.
 *
 * Travel-mode mapping uses the OSRM-standard names `'driving'/'walking'/
 * 'cycling'` (consistent with OSRM Routing). Consumers must
 * verify their OSRM build has the requested profile compiled.
 */
export class OsrmMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'osrm';

  constructor(private config: OsrmConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    validateMatrixOptions(options, 'OSRM Matrix');
    // Validated at CALL time, not construction time — see the routing connector.
    const baseUrl = validateOsrmBaseUrl(this.config);

    // pre-flight validation runs synchronously before any HTTP call.
    const excludes = resolveOsrmExcludes({ avoidTolls: options.avoidTolls }, this.config);

    // Empty origins/destinations would build an invalid `/table/v1/{profile}/`
    // URL with an empty coord segment + empty `sources`/`destinations`. Reject
    // locally with a clear error rather than surfacing an opaque vendor 400/404.
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

    const url = `${baseUrl}/table/v1/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      sources: originIndices.join(';'),
      destinations: destinationIndices.join(';'),
      // OSRM's default is duration-only; asking for both is what populates
      // `distanceMeters`. A default like any other, so passthrough replaces it.
      annotations: OSRM_TABLE_ANNOTATIONS.join(','),
    };
    if (excludes.length > 0) {
      baseQuery.exclude = excludes.join(',');
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    // A truncated/non-JSON 200 body must surface as a typed error, not an
    // unwrapped SyntaxError.
    const data = (await response.json().catch(() => null)) as
      | OsrmTableResponse
      | null;

    // OSRM in-body status codes trigger typed errors even on HTTP 200.
    if (data === null || typeof data !== 'object' || data.code !== 'Ok') {
      throw this.mapInBodyError(data ?? {}, response.status);
    }

    // 2D-to-flat-cells normalization (origin-major). Index loop emits
    // every (origin, destination) pair. Native units (meters + seconds).
    const durations = data.durations ?? [];
    const distances = data.distances ?? [];

    // Verify the vendor's 2D matrices match the requested origins×destinations
    // dimensions BEFORE flattening. OSRM returns one row per source and one
    // column per destination; a sparse, asymmetric, or short matrix would
    // otherwise leave cells unread — returning WRONG cells with no signal.
    assertMatrixDimensions(
      durations,
      distances,
      options.origins.length,
      options.destinations.length,
      data,
      response.status,
    );

    const cells: IMatrixCell[] = [];
    for (let oi = 0; oi < options.origins.length; oi++) {
      for (let di = 0; di < options.destinations.length; di++) {
        const durationSeconds = durations[oi]?.[di];
        const distanceMeters = distances[oi]?.[di];
        // OSRM `/table` returns `null` for an unroutable pair. Omit the cell
        // rather than coercing to 0 (which reads as "same location"). Contract:
        // missing/failed entries are omitted from `cells[]`.
        if (durationSeconds == null || distanceMeters == null) continue;
        if (!isFiniteNumber(durationSeconds) || !isFiniteNumber(distanceMeters)) {
          throw malformedResponseError(
            'OSRM matrix',
            `cell ${oi}→${di} is not a number`,
            response.status,
            data,
          );
        }
        cells.push({
          originIndex: oi,
          destinationIndex: di,
          durationSeconds,
          distanceMeters,
        });
      }
    }

    return { cells, raw: data };
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
    body: Record<string, unknown> | null,
  ): ProviderCode {
    // Proxy-layer statuses win: a 401/429 from a reverse proxy has no OSRM
    // envelope to read.
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    // OSRM serves every non-Ok envelope code with a 4xx, so the code — not the
    // status — separates "no road near a coordinate" (`NoSegment`) from "your
    // request was wrong", exactly as on the routing connector.
    const classified = classifyTableEnvelopeCode(body);
    if (classified !== null) return classified;

    if (httpStatus === 400 || httpStatus === 404) return 'invalid_request';
    return 'unknown';
  }

  /**
   * Map an in-body OSRM status code (`data.code !== 'Ok'`) on a 2xx to a typed
   * {@link ConnectorError}, with the same classification as the 4xx path.
   * `statusCode` is the real status: the provider answered.
   */
  private mapInBodyError(
    body: { code?: unknown; message?: unknown },
    statusCode: number,
  ): ConnectorError {
    const code = typeof body.code === 'string' ? body.code : '';
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : '';

    const providerCode: ProviderCode = classifyTableEnvelopeCode(body) ?? 'unknown';

    const providerMessage =
      message !== '' ? message : `OSRM returned code: ${code || 'unknown'}`;

    return new ConnectorError({
      message: providerMessage,
      statusCode,
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
 * The three base modes map 1:1 onto the OSRM-standard profile names
 * `driving / walking / cycling`, matching {@link OsrmRoutingConnector}. Whether a
 * profile exists is a property of the operator's build, not of the mapping.
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
 * The `/table` classification: the routing connector's envelope codes, plus
 * `NoTable`, which OSRM's Table service documents as "No route found".
 */
function classifyTableEnvelopeCode(
  body: { code?: unknown; message?: unknown } | null,
): ProviderCode | null {
  if (body !== null && typeof body === 'object' && body.code === 'NoTable') {
    return 'no_route';
  }
  return classifyOsrmEnvelopeCode(body, 'table');
}

/**
 * Guard that the vendor's `durations`/`distances` 2D arrays cover the full
 * requested origins×destinations grid before the row-major flatten. Throws a
 * typed {@link ConnectorError} (`providerCode: 'unknown'`, the closest existing
 * value for a malformed provider body) when either matrix has too few rows or
 * any row is shorter than the requested destination stride — the cases where a
 * cell would otherwise be silently fabricated or dropped. The full vendor body
 * is preserved on `cause`.
 */
function assertMatrixDimensions(
  durations: unknown,
  distances: unknown,
  numOrigins: number,
  numDestinations: number,
  raw: unknown,
  statusCode: number,
): asserts durations is (number | null)[][] {
  const dimensionsOk =
    Array.isArray(durations) &&
    Array.isArray(distances) &&
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
      statusCode,
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
