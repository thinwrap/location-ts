import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { TomTomConfig } from './tomtom.config';
import type { TomTomMatrixResponse } from './tomtom.types';

const SYNC_MATRIX_URL = 'https://api.tomtom.com/routing/matrix/2';
const ASYNC_MATRIX_URL = 'https://api.tomtom.com/routing/matrix/2/async';
const SYNC_CELL_THRESHOLD = 2_500;
const POLL_INITIAL_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const POLL_BACKOFF_MULTIPLIER = 1.5;
const POLL_DEFAULT_DEADLINE_MS = 60_000;

/**
 * TomTom Matrix v2 connector — architectural outlier #2 for Matrix.
 *
 * Unlike HERE Matrix v8 (always async) and Google/Mapbox/Esri
 * (always sync), TomTom Matrix v2 is **conditionally async** — dispatch is
 * driven by the cell-count threshold (`origins.length * destinations.length`):
 *
 *   - ≤ 2500 cells → single sync `POST /routing/matrix/2`. The response carries
 *     `data[]` directly and is flattened to {@link IMatrixCell}[].
 *   - > 2500 cells → submit-poll-retrieve via `/routing/matrix/2/async`:
 *       1. `POST /async?key=…` returns `{ jobId }`.
 *       2. `GET /async/{jobId}?key=…` is polled with exponential backoff
 *          (1s start, x1.5, capped at 5s) until `state === 'Completed'`,
 *          `state === 'Failed'`, or the 60s deadline expires.
 *       3. `GET /async/{jobId}/result?key=…` retrieves the same `data[]` shape
 *          as the sync path.
 *
 * (async polling locality), the polling loop lives entirely inside
 * this connector with no shared middleware (parity with {@link HereMatrixConnector}).
 *
 * Polling deadline override: `options._passthrough.body.timeoutMs`
 * (consumer-supplied, in milliseconds). The `timeoutMs`
 * key is stripped from the wire body so it never reaches the vendor.
 *
 * Per-connector error mapping: 401/403 → `auth_failed`, 400/404 →
 * `invalid_request`, 429 → `rate_limited`, 5xx → `provider_unavailable`,
 * other → `unknown`. Retry-After surfacing: parsed seconds in `providerMessage`
 * + raw header in `cause.retryAfter` by design (no structured `retryAfterSeconds`
 * field).
 *
 * Deadline timeout raises `ProviderCode.matrix_polling_timeout` with
 * `cause.jobId` so consumers can resume out-of-band.
 */
export class TomTomMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'tomtom';
  private readonly sleepFn: (ms: number) => Promise<void>;

  /**
   * @param config TomTom API config.
   * @param fetchImpl Optional `fetch` override (BYO fetch (the wrapper holds no state)).
   * @param sleepFn Optional sleep injection (ms). Tests pass a no-op to
   *        compress the polling loop without using fake timers.
   */
  constructor(
    private config: TomTomConfig,
    fetchImpl?: typeof fetch,
    sleepFn?: (ms: number) => Promise<void>,
  ) {
    super(fetchImpl);
    this.sleepFn =
      sleepFn ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    // Reject NaN/non-finite coordinates before they serialize into the JSON
    // body (JSON.stringify(NaN) === "null" would silently corrupt the request);
    // covers both the sync and async dispatch paths below. Out-of-range but
    // finite lat/lng pass through verbatim (thin-wrapper).
    for (const coord of [...options.origins, ...options.destinations]) {
      assertFiniteCoordinate(coord, 'TomTom Matrix');
    }

    const cellCount = options.origins.length * options.destinations.length;

    if (cellCount <= SYNC_CELL_THRESHOLD) {
      return this.matrixSync(options);
    }

    return this.matrixAsync(options);
  }

  /**
   * Sync path (≤2500 cells): single POST to `/routing/matrix/2`.
   */
  private async matrixSync(options: IMatrixOptions): Promise<IMatrixResult> {
    const { body, query } = this.buildRequest(options);

    const merged = mergePassthrough(body, {}, options._passthrough, query);

    // `timeoutMs` is a wrapper-side knob, not a TomTom wire field — strip it
    // from the merged body so it never reaches the vendor (parity with HERE).
    const mergedBody = merged.body as Record<string, unknown>;
    if ('timeoutMs' in mergedBody) {
      delete mergedBody.timeoutMs;
    }

    const response = await this.sendPostJson(SYNC_MATRIX_URL, mergedBody, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Matrix sync');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomMatrixResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'TomTom Matrix sync returned non-JSON body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Matrix sync returned non-JSON body',
        cause: data,
      });
    }

    return this.normalizeCells(
      data,
      options.origins.length,
      options.destinations.length,
    );
  }

  /**
   * Async path (>2500 cells): submit → poll → retrieve.
   */
  private async matrixAsync(options: IMatrixOptions): Promise<IMatrixResult> {
    const jobId = await this.submitAsync(options);
    await this.pollAsync(jobId, options);
    return this.retrieveAsync(
      jobId,
      options.origins.length,
      options.destinations.length,
    );
  }

  /**
   * Step 1: submit async matrix job. Returns the `jobId`.
   */
  private async submitAsync(options: IMatrixOptions): Promise<string> {
    const { body, query } = this.buildRequest(options);

    const merged = mergePassthrough(body, {}, options._passthrough, query);

    const mergedBody = merged.body as Record<string, unknown>;
    if ('timeoutMs' in mergedBody) {
      delete mergedBody.timeoutMs;
    }

    const response = await this.sendPostJson(ASYNC_MATRIX_URL, mergedBody, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Matrix submit');
    }

    const data = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const jobId =
      data !== null && typeof data.jobId === 'string' && data.jobId !== ''
        ? data.jobId
        : null;

    if (jobId === null) {
      throw new ConnectorError({
        message: 'TomTom Matrix submit response missing jobId',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Matrix submit response missing jobId',
        cause: data,
      });
    }

    return jobId;
  }

  /**
   * Step 2: poll the async job until `Completed`, `Failed`, or deadline.
   *
   * Exponential backoff: start 1 s, multiplier 1.5, capped at 5 s. Deadline
   * configurable via `options._passthrough.body.timeoutMs`; default 60 s
   * Sleeps are bounded by remaining deadline so we never overshoot.
   *
   * Raises `'matrix_polling_timeout'` on deadline expiry with `cause.jobId`
   * so consumers can resume out-of-band.
   */
  private async pollAsync(
    jobId: string,
    options: IMatrixOptions,
  ): Promise<void> {
    const deadlineMs = this.resolveDeadlineMs(options);
    const deadlineAt = Date.now() + deadlineMs;
    const statusUrl = `${ASYNC_MATRIX_URL}/${encodeURIComponent(jobId)}`;

    let delayMs = POLL_INITIAL_DELAY_MS;

    while (true) {
      const now = Date.now();
      if (now >= deadlineAt) break;

      // Bound the next sleep so we never overshoot the deadline.
      const remainingMs = deadlineAt - now;
      const sleepMs = delayMs < remainingMs ? delayMs : remainingMs;
      await this.sleepFn(sleepMs);

      delayMs = Math.min(
        POLL_MAX_DELAY_MS,
        Math.round(delayMs * POLL_BACKOFF_MULTIPLIER),
      );

      const statusResponse = await this.sendGet(statusUrl, {
        query: { key: this.config.apiKey },
      });

      if (!statusResponse.ok) {
        throw await this.raiseHttpError(statusResponse, 'TomTom Matrix poll');
      }

      const status = (await statusResponse.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const state =
        status !== null && typeof status.state === 'string'
          ? status.state
          : null;

      // TomTom Matrix v2 async job states are Submitted | Validated |
      // Completed | Failed. Success is 'Completed' (there is no 'Succeeded').
      if (state === 'Completed') return;

      if (state === 'Failed') {
        throw new ConnectorError({
          message: 'TomTom Matrix job failed',
          statusCode: statusResponse.status,
          providerCode: 'provider_unavailable',
          providerMessage: 'TomTom Matrix job failed',
          cause: status,
        });
      }

      // Otherwise continue polling on 'Pending' / 'Running' / etc.
    }

    throw new ConnectorError({
      message: 'TomTom Matrix polling deadline exceeded',
      statusCode: null,
      providerCode: 'matrix_polling_timeout',
      providerMessage: `jobId: ${jobId}`,
      cause: { jobId },
    });
  }

  /**
   * Step 3: retrieve the final async matrix payload (same `data[]` shape as
   * the sync response).
   */
  private async retrieveAsync(
    jobId: string,
    numOrigins: number,
    numDestinations: number,
  ): Promise<IMatrixResult> {
    const resultUrl = `${ASYNC_MATRIX_URL}/${encodeURIComponent(jobId)}/result`;

    const response = await this.sendGet(resultUrl, {
      query: { key: this.config.apiKey },
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Matrix retrieve');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomMatrixResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'TomTom Matrix retrieve returned non-JSON body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'TomTom Matrix retrieve returned non-JSON body',
        cause: data,
      });
    }

    return this.normalizeCells(data, numOrigins, numDestinations);
  }

  /**
   * Build the shared origins/destinations/options body + query (sync + async
   * use identical request shapes).
   */
  private buildRequest(options: IMatrixOptions): {
    body: Record<string, unknown>;
    query: Record<string, string>;
  } {
    const bodyOptions: Record<string, unknown> = {
      travelMode: this.mapTravelMode(options.travelMode),
    };

    if (options.avoidTolls === true) {
      bodyOptions.avoid = ['tollRoads'];
    }

    if (options.departureTime) {
      bodyOptions.departAt = options.departureTime.toISOString();
    }

    const body: Record<string, unknown> = {
      origins: options.origins.map((o) => ({
        point: { latitude: o.lat, longitude: o.lng },
      })),
      destinations: options.destinations.map((d) => ({
        point: { latitude: d.lat, longitude: d.lng },
      })),
      options: bodyOptions,
    };

    const query: Record<string, string> = { key: this.config.apiKey };

    return { body, query };
  }

  /**
   * Flatten the `data[]` array (shared between sync and async result shapes)
   * into `IMatrixCell[]`. Cells without `routeSummary` are skipped, matching
   * the sibling PHP connector. Native meters + seconds.
   *
   * A SPARSE result (an unroutable origin×destination pair dropped by TomTom)
   * is OMITTED rather than erroring the whole call — each returned cell carries
   * its `originIndex`/`destinationIndex`, so a consumer can tell exactly which
   * pairs are present. This matches the Mapbox/OSRM/HERE/Google cell-omission
   * semantics (supersedes the earlier loc-CR #100 whole-grid guard, which
   * diverged from every other provider).
   */
  private normalizeCells(
    data: TomTomMatrixResponse,
    _numOrigins: number,
    _numDestinations: number,
  ): IMatrixResult {
    const cells: IMatrixCell[] = [];
    const entries = Array.isArray(data.data) ? data.data : [];

    for (const entry of entries) {
      if (entry.routeSummary) {
        cells.push({
          originIndex: entry.originIndex,
          destinationIndex: entry.destinationIndex,
          distanceMeters: entry.routeSummary.lengthInMeters,
          durationSeconds: entry.routeSummary.travelTimeInSeconds,
        });
      }
    }

    return { cells, raw: data };
  }

  /**
   * Resolve the polling deadline (ms). Honors
   * `options._passthrough.body.timeoutMs` when present and positive,
   * else falls back to 60 s default.
   */
  private resolveDeadlineMs(options: IMatrixOptions): number {
    const raw = options._passthrough?.body?.timeoutMs;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return POLL_DEFAULT_DEADLINE_MS;
  }

  /**
   * Map TomTom (HTTP status, body) → canonical {@link ProviderCode}.
   * the mapping lives per-connector.
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
   * Map the unified travel mode → TomTom Matrix v2 `travelMode`. TomTom Matrix
   * v2 supports only `car` / `pedestrian` (no bicycle endpoint), so `cycling`
   * is rejected with `unsupported_travel_mode` rather than silently forwarded
   *
   */
  private mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'pedestrian';
      case 'cycling':
        throw new ConnectorError({
          message: 'TomTom Matrix v2 does not support cycling',
          statusCode: null,
          providerCode: 'unsupported_travel_mode',
          providerMessage: 'TomTom Matrix v2 does not support cycling',
        });
      default:
        return 'car';
    }
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design.
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readTomTomErrorMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
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
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function readTomTomErrorMessage(
  body: Record<string, unknown> | null,
): string | null {
  if (body === null) return null;

  // TomTom errors typically arrive as either:
  //   { error: { description: "..." } }
  //   { error: "..." }
  //   { detailedError: { message: "..." } }
  //   { message: "..." }
  const detailed = body.detailedError;
  if (detailed !== null && typeof detailed === 'object') {
    const msg = (detailed as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg !== '') return msg;
  }

  const errorField = body.error;
  if (errorField !== null && typeof errorField === 'object') {
    const errObj = errorField as Record<string, unknown>;
    const description = errObj.description;
    if (typeof description === 'string' && description !== '') return description;
    const message = errObj.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof errorField === 'string' && errorField !== '') return errorField;

  if (typeof body.message === 'string' && body.message !== '') {
    return body.message;
  }

  return null;
}
