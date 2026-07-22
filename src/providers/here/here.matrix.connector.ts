import { gunzipSync } from 'node:zlib';
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
import type { HereConfig } from './here.config';
import type { HereMatrixResponse } from './here.types';

const MATRIX_URL = 'https://matrix.router.hereapi.com/v8/matrix';
const POLL_INITIAL_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const POLL_BACKOFF_MULTIPLIER = 1.5;
const POLL_DEFAULT_DEADLINE_MS = 60_000;

/**
 * Provider-narrowed {@link IMatrixOptions} for HERE. HERE Matrix v8 supports a
 * richer set of vehicle classes than the base `travelMode` via `transportMode`.
 *
 * Module-augmentation of `MatrixOptionsMap` is layered on top so that
 * `new Matrix('here', cfg).matrix(input)` narrows its parameter type.
 */
export interface HereMatrixOptions extends IMatrixOptions {
  transportMode?: 'car' | 'truck' | 'pedestrian' | 'bicycle' | 'scooter';
}

declare module '../../types/matrix.interface' {
  interface MatrixOptionsMap {
    here: HereMatrixOptions;
  }
}

/**
 * HERE Matrix v8 connector — architectural outlier #1 for Matrix.
 *
 * HERE Matrix v8 is ALWAYS async — every request runs through a three-call
 * submit-poll-retrieve cycle. (async polling locality), the polling
 * loop lives entirely inside this connector with no shared middleware.
 *
 *   1. `POST https://matrix.router.hereapi.com/v8/matrix?async=true&apiKey=...`
 *      submits the job; HERE returns `matrixId` + `statusUrl`.
 *   2. `GET <statusUrl>` is polled with exponential backoff (1s start, x1.5,
 *      capped at 5s) until `status === 'completed'`, `status === 'failed'`, or
 *      the 60 s deadline expires.
 *   3. `GET <resultUrl>` retrieves the final 2D matrix payload, flattened to
 * `cells[]`.
 *
 * Polling deadline override: `options._passthrough.body.timeoutMs`
 * (consumer-supplied, in milliseconds). Per the baseline-coverage rule,
 * fields ≤33% of providers use go to `_passthrough` not the base
 * interface — `timeoutMs` is HERE+TomTom only.
 *
 * Per-connector error mapping: 401/403 → `auth_failed`, 400 →
 * `invalid_request`, 429 → `rate_limited`, 5xx → `provider_unavailable`,
 * other → `unknown`. Retry-After surfacing: parsed seconds in `providerMessage`
 * + raw header in `cause.retryAfter` by design (no structured retryAfterSeconds field).
 *
 * Deadline timeout raises `ProviderCode.matrix_polling_timeout` with
 * `cause.matrixId` so consumers can resume out-of-band.
 */
export class HereMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'here';
  private readonly sleepFn: (ms: number) => Promise<void>;

  /**
   * @param config HERE API config.
   * @param fetchImpl Optional `fetch` override (BYO fetch (the wrapper holds no state)).
   * @param sleepFn Optional sleep injection (ms). Tests pass a no-op or fake
   *        timer to compress the polling loop.
   */
  constructor(
    private config: HereConfig,
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
    // body (JSON.stringify(NaN) === "null" would silently corrupt the request)
    // and before the submit round-trip. Out-of-range but finite lat/lng pass
    // through verbatim (thin-wrapper).
    for (const coord of [...options.origins, ...options.destinations]) {
      assertFiniteCoordinate(coord, 'HERE Matrix');
    }

    const { matrixId, statusUrl } = await this.submit(options);
    const resultUrl = await this.poll(matrixId, statusUrl, options);
    return this.retrieve(resultUrl, options);
  }

  /**
   * Step 1: submit the matrix job. Returns `matrixId` + `statusUrl`.
   */
  private async submit(
    options: IMatrixOptions,
  ): Promise<{ matrixId: string; statusUrl: string }> {
    const body: Record<string, unknown> = {
      origins: options.origins.map((o) => ({ lat: o.lat, lng: o.lng })),
      destinations: options.destinations.map((d) => ({
        lat: d.lat,
        lng: d.lng,
      })),
      regionDefinition: { type: 'autoCircle' },
      matrixAttributes: ['travelTimes', 'distances'],
    };

    const profile = this.resolveTransportMode(options);
    if (profile !== 'car') {
      body.transportMode = profile;
    }

    if (options.avoidTolls === true) {
      body.avoid = { features: ['tollRoad'] };
    }

    if (options.departureTime) {
      body.departureTime = options.departureTime.toISOString();
    }

    const headers: Record<string, string> = {};
    const baseQuery: Record<string, string> = {
      apiKey: this.config.apiKey,
      async: 'true',
    };

    const merged = mergePassthrough(body, headers, options._passthrough, baseQuery);

    // `timeoutMs` is a wrapper-side knob, not a HERE wire field — strip it from
    // the merged body so it never reaches the vendor.
    const mergedBody = merged.body as Record<string, unknown>;
    if ('timeoutMs' in mergedBody) {
      delete mergedBody.timeoutMs;
    }

    const response = await this.sendPostJson(MATRIX_URL, mergedBody, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Matrix submit');
    }

    const data = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const matrixId =
      data !== null && typeof data.matrixId === 'string' ? data.matrixId : null;
    const statusUrl =
      data !== null && typeof data.statusUrl === 'string'
        ? data.statusUrl
        : null;

    if (matrixId === null || statusUrl === null) {
      throw new ConnectorError({
        message: 'HERE Matrix submit response missing matrixId or statusUrl',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage:
          'HERE Matrix submit response missing matrixId or statusUrl',
        cause: data,
      });
    }

    return { matrixId, statusUrl };
  }

  /**
   * Step 2: poll the status URL until completion, failure, or deadline.
   *
   * Exponential backoff: start 1 s, multiplier 1.5, capped at 5 s. Deadline is
   * configurable via `options._passthrough.body.timeoutMs`; default 60 s.
   * Sleeps are bounded by remaining deadline so we never overshoot.
   *
   * Returns the resolved `resultUrl` on completion. Raises
   * `'matrix_polling_timeout'` on deadline expiry with `cause.matrixId` so
   * consumers can resume out-of-band.
   */
  private async poll(
    matrixId: string,
    statusUrl: string,
    options: IMatrixOptions,
  ): Promise<string> {
    // Validate the provider-supplied statusUrl before ever attaching the API
    // key to it (WI-3): reject non-HERE hosts / malformed URLs up front.
    this.assertHereApiUrl(statusUrl, 'statusUrl');

    const deadlineMs = this.resolveDeadlineMs(options);
    const deadlineAt = Date.now() + deadlineMs;

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

      const statusResponse = await this.hereGet(statusUrl, {
        query: { apiKey: this.config.apiKey },
      });

      // Real HERE v8 behavior: on completion the poll returns `303 See Other`
      // with `Location: <resultUrl>` and a body `{status:"completed",
      // resultUrl}`. This MUST be handled BEFORE the generic non-2xx guard
      // below (a 303 is not `ok`, so it would otherwise raise). `pollGet` uses
      // `redirect: 'manual'` so the 303 is observable here rather than
      // surfacing as a thrown network error (the base transport forces
      // `redirect: 'error'`, which turns the redirect into a failure).
      if (statusResponse.status === 303) {
        const body = (await statusResponse.json().catch(() => null)) as
          | Record<string, unknown>
          | null;
        return this.requireResultUrl(body, statusResponse);
      }

      if (!statusResponse.ok) {
        throw await this.raiseHttpError(statusResponse, 'HERE Matrix poll');
      }

      const status = (await statusResponse.json().catch(() => null)) as
        | Record<string, unknown>
        | null;

      const state =
        status !== null && typeof status.status === 'string'
          ? status.status
          : status !== null && typeof status.state === 'string'
            ? status.state
            : null;

      // A 200 body with status "completed" is also treated as completion
      // (belt-and-braces alongside the 303 path above), reading resultUrl from
      // the body or the Location header.
      if (state === 'completed') {
        return this.requireResultUrl(status, statusResponse);
      }

      if (state === 'failed') {
        throw new ConnectorError({
          message: 'HERE Matrix job failed',
          statusCode: statusResponse.status,
          providerCode: 'provider_unavailable',
          providerMessage: 'HERE Matrix job failed',
          cause: status,
        });
      }

      // Otherwise continue polling on 'pending'/'inProgress'/etc.
    }

    throw new ConnectorError({
      message: 'HERE Matrix polling deadline exceeded',
      statusCode: null,
      providerCode: 'matrix_polling_timeout',
      providerMessage: `matrixId: ${matrixId}`,
      cause: { matrixId, statusUrl },
    });
  }

  /**
   * Step 3: retrieve the final matrix payload and flatten to cells.
   *
   * HERE returns a 2D matrix as flat arrays `travelTimes` + `distances` of
   * length `numOrigins * numDestinations`; flatten via row-major index
   * `oi * numDestinations + di` to `cells[]`.
   */
  private async retrieve(
    resultUrl: string,
    options: IMatrixOptions,
  ): Promise<IMatrixResult> {
    // Validate the provider-supplied resultUrl before attaching the API key
    // (WI-3): reject non-HERE hosts / malformed URLs up front.
    this.assertHereApiUrl(resultUrl, 'resultUrl');

    // Step 3a: GET the (validated hereapi.com) resultUrl WITH the apiKey. HERE
    // requires the apiKey here (401 without) and the request header
    // `Accept-Encoding: gzip` (406 Not Acceptable without). On success HERE does
    // NOT return the payload inline — it responds `303 See Other` with
    // `Location: <pre-signed S3 URL>`. We read that redirect MANUALLY
    // (redirect:'manual', via hereGet) rather than auto-following, so the
    // apiKey is never forwarded off the HERE host to the storage backend.
    let response = await this.hereGet(resultUrl, {
      query: { apiKey: this.config.apiKey },
      headers: { 'Accept-Encoding': 'gzip' },
    });

    // Step 3b: follow the single redirect hop to the pre-signed result URL,
    // WITHOUT attaching the apiKey — the signed URL is self-authenticating (it
    // carries its own AWS SigV4 query params) and lives on a non-HERE host, so
    // it is intentionally not run through assertHereApiUrl and never receives
    // the key. A direct 200 (no redirect — the shape the public docs describe)
    // is handled by simply skipping this hop.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || location === '') {
        throw new ConnectorError({
          message: 'HERE Matrix retrieve redirect missing Location header',
          statusCode: response.status,
          providerCode: 'unknown',
          providerMessage:
            'HERE Matrix retrieve redirect missing Location header',
          cause: null,
        });
      }
      // The redirect target is a non-HERE (pre-signed storage) host so it isn't
      // run through assertHereApiUrl, but it MUST still be https — refuse a
      // plaintext/other-scheme downgrade from a tampered/misbehaving response.
      let redirectProtocol: string | null = null;
      try {
        redirectProtocol = new URL(location).protocol;
      } catch {
        redirectProtocol = null;
      }
      if (redirectProtocol !== 'https:') {
        throw new ConnectorError({
          message: 'HERE Matrix result redirect must be an https URL',
          statusCode: response.status,
          providerCode: 'unknown',
          providerMessage: 'HERE Matrix result redirect must be an https URL',
          cause: null,
        });
      }
      response = await this.hereGet(location, {
        headers: { 'Accept-Encoding': 'gzip' },
      });
    }

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Matrix retrieve');
    }

    const data = await this.readMatrixBody(response);
    if (data === null || data.matrix === undefined || data.matrix === null) {
      throw new ConnectorError({
        message: 'HERE Matrix retrieve missing matrix payload',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Matrix retrieve missing matrix payload',
        cause: data,
      });
    }

    const { numDestinations, travelTimes, distances, errorCodes } = data.matrix;
    const originCount = options.origins.length;
    const destCount = options.destinations.length;

    // HERE lays out the flat travelTimes/distances arrays row-major by the
    // dimensions IT returns, so index with the vendor's numDestinations as the
    // row stride. NOTE (loc-CR #34/#62/#98, 2026-05-29): when HERE de-dupes /
    // region-clamps and its destination count differs from the request, a flat
    // stride cannot recover the true request↔vendor index mapping — resolving
    // that correctly needs the HERE response contract and is DEFERRED to a
    // follow-up rather than guessed here.
    const stride =
      typeof numDestinations === 'number' && numDestinations > 0
        ? numDestinations
        : destCount;

    // LOC-CP-1 (loc-CR #79/#85/#99): verify the flat travelTimes/distances
    // arrays are long enough to cover every (origin, destination) index BEFORE
    // flattening. The highest index read below is `(originCount - 1) * stride +
    // (destCount - 1)`, so each array must hold at least that many + 1 entries.
    // A short/sparse vendor payload (HERE omitting unreachable entries, or a
    // truncated array) would otherwise be silently zero-filled by the `?? 0`
    // cell reads — returning WRONG cells with no signal. We surface a typed
    // ConnectorError instead (mirrors the missing-matrix-payload guard above).
    // This does NOT attempt to recover the request↔vendor index mapping when
    // HERE de-dupes/region-clamps (still deferred per #34/#62/#98 note above) —
    // it only rejects payloads too short to flatten safely. No
    // 'invalid_response' ProviderCode exists in error.types.ts; 'unknown' is
    // the closest existing value for a malformed provider body.
    const expectedLength =
      originCount > 0 && destCount > 0
        ? (originCount - 1) * stride + destCount
        : 0;
    if (
      (travelTimes?.length ?? 0) < expectedLength ||
      (distances?.length ?? 0) < expectedLength
    ) {
      const message =
        `HERE Matrix returned arrays too short for the requested ` +
        `${originCount}×${destCount} dimensions (stride ${stride})`;
      throw new ConnectorError({
        message,
        statusCode: null,
        providerCode: 'unknown',
        providerMessage: message,
        cause: data,
      });
    }

    const cells: IMatrixCell[] = [];
    for (let oi = 0; oi < originCount; oi++) {
      for (let di = 0; di < destCount; di++) {
        const index = oi * stride + di;
        // HERE reports per-cell failures via `errorCodes` (0 = OK, 3 = computed
        // with a violated constraint but still usable). Any other non-zero code
        // means the travelTimes/distances value is unspecified — omit the cell
        // rather than emit its sentinel value. Contract: failed entries are
        // omitted from `cells[]`.
        const errorCode = errorCodes?.[index];
        if (errorCode !== undefined && errorCode !== 0 && errorCode !== 3) {
          continue;
        }
        const cell: IMatrixCell = {
          originIndex: oi,
          destinationIndex: di,
          durationSeconds: travelTimes?.[index] ?? 0,
          distanceMeters: distances?.[index] ?? 0,
        };
        cells.push(cell);
      }
    }

    return { cells, raw: data };
  }

  /**
   * Connector-local GET for the async poll + retrieve steps. Unlike
   * {@link BaseConnector.sendGet} — which forces `redirect: 'error'` so a
   * redirect never silently re-sends auth to the target — this uses
   * `redirect: 'manual'` so HERE's async redirects are OBSERVABLE (status +
   * `Location` header readable) instead of surfacing as a thrown network error.
   * Both HERE async hops are `303 See Other`: the poll completion redirects to
   * the resultUrl, and the resultUrl redirects to a pre-signed S3 object URL.
   * `manual` does NOT follow the redirect, so this connector decides — per hop —
   * whether to attach the apiKey (only to validated hereapi.com hosts) before
   * fetching the next URL. Mirrors the base transport's error sanitization (a
   * leaky BYO-fetch message could embed the key-bearing URL, so it is never
   * propagated verbatim). Kept local per the per-connector-locality invariant.
   */
  private async hereGet(
    url: string,
    options?: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const qs = options?.query
      ? new URLSearchParams(options.query).toString()
      : '';
    const separator = url.includes('?') ? '&' : '?';
    const finalUrl = qs.length === 0 ? url : `${url}${separator}${qs}`;
    try {
      return await this.fetchImpl(finalUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: options?.headers,
      });
    } catch (err) {
      throw new ConnectorError({
        message: 'Network request failed',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: { name: (err as Error)?.name } },
      });
    }
  }

  /**
   * Resolve the async result URL from a completed poll response: the body's
   * `resultUrl` (preferred; present in both the 303 body and any 200 completed
   * body) or the `Location` response header (set on the 303). Raises a typed
   * {@link ConnectorError} when neither is present.
   */
  private requireResultUrl(
    body: Record<string, unknown> | null,
    response: Response,
  ): string {
    const fromBody =
      body !== null &&
      typeof body.resultUrl === 'string' &&
      body.resultUrl !== ''
        ? body.resultUrl
        : null;
    const location = response.headers.get('location');
    const resultUrl =
      fromBody ?? (location !== null && location !== '' ? location : null);
    if (resultUrl === null) {
      throw new ConnectorError({
        message: 'HERE Matrix poll completed without resultUrl',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Matrix poll completed without resultUrl',
        cause: body,
      });
    }
    return resultUrl;
  }

  /**
   * Read + JSON-parse the retrieve body, decompressing defensively. HERE serves
   * the matrix result gzip-compressed; because the retrieve sets
   * `Accept-Encoding: gzip` itself, the default undici transport does NOT
   * auto-decompress, so the body arrives as raw gzip bytes (magic `0x1f 0x8b`,
   * `Content-Encoding: gzip`) which are gunzipped via Node's built-in `zlib`
   * (zero runtime deps). A transport that already decompressed presents plain
   * JSON (no gzip magic / stripped `Content-Encoding`) and parses directly. The
   * gunzip is guarded so a stray `Content-Encoding` header on an
   * already-decompressed body cannot throw. Kept local per per-connector
   * locality.
   */
  private async readMatrixBody(
    response: Response,
  ): Promise<HereMatrixResponse | null> {
    const raw = Buffer.from(await response.arrayBuffer());
    const encoding = response.headers.get('content-encoding');
    const looksGzipped =
      (encoding !== null && encoding.toLowerCase().includes('gzip')) ||
      (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b);

    let jsonBuf = raw;
    if (looksGzipped) {
      try {
        jsonBuf = gunzipSync(raw);
      } catch {
        // Body was already decompressed by the transport but still carried the
        // Content-Encoding header — parse the raw bytes as-is.
        jsonBuf = raw;
      }
    }

    try {
      return JSON.parse(jsonBuf.toString('utf8')) as HereMatrixResponse;
    } catch {
      return null;
    }
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
   * Resolve the wire-level `transportMode` string. When the caller passed a
   * narrowed {@link HereMatrixOptions} with `transportMode`, it overrides the
   * base {@link IMatrixOptions.travelMode} mapping.
   */
  private resolveTransportMode(options: IMatrixOptions): string {
    const narrowed = options as HereMatrixOptions;
    if (typeof narrowed.transportMode === 'string') {
      return narrowed.transportMode;
    }
    return mapTravelMode(options.travelMode);
  }

  /**
   * Validate a provider-supplied async URL (`statusUrl`/`resultUrl`) before
   * attaching the API key and fetching it. HERE returns these URLs verbatim in
   * the submit response; a tampered submit response could otherwise exfiltrate
   * `apiKey` to an arbitrary host. Require `https:` and a hostname that matches
   * the submit endpoint's host or lives under the HERE API domain
   * (`*.hereapi.com` / `hereapi.com`). A malformed URL string is rejected with
   * the same typed {@link ConnectorError} rather than an uncaught `TypeError`.
   */
  private assertHereApiUrl(rawUrl: string, label: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ConnectorError({
        message: `HERE Matrix ${label} is not a valid URL`,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: `HERE Matrix ${label} is not a valid URL`,
        cause: { url: rawUrl },
      });
    }

    const submitHost = new URL(MATRIX_URL).hostname;
    const host = parsed.hostname;
    const hostAllowed =
      host === submitHost ||
      host === 'hereapi.com' ||
      host.endsWith('.hereapi.com');

    if (parsed.protocol !== 'https:' || !hostAllowed) {
      throw new ConnectorError({
        message: `HERE Matrix ${label} points to an unexpected host`,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: `HERE Matrix ${label} points to an unexpected host`,
        cause: { url: rawUrl },
      });
    }
  }

  /**
   * Map HERE (HTTP status, body) → canonical {@link ProviderCode}.
   * the mapping lives per-connector (no shared middleware).
   */
  private mapVendorError(
    httpStatus: number,
    _body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design.
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readHereErrorMessage(body);

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

function mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
  switch (mode) {
    case 'walking':
      return 'pedestrian';
    case 'cycling':
      return 'bicycle';
    default:
      return 'car';
  }
}

function readHereErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  // HERE v8 errors: { title, cause, status }.
  const title = obj.title;
  const cause = obj.cause;
  if (typeof title === 'string' && title !== '') {
    if (typeof cause === 'string' && cause !== '') {
      return `${title}: ${cause}`;
    }
    return title;
  }
  if (typeof cause === 'string' && cause !== '') return cause;

  // Fallback: nested { error: { message } } or top-level { message } / { error }.
  const error = obj.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof obj.message === 'string' && obj.message !== '') return obj.message;
  if (typeof error === 'string' && error !== '') return error;

  return null;
}
