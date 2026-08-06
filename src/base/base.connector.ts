import { ConnectorError } from '../types/error.types';

/**
 * Default per-request bound, so a hung provider cannot leave the caller's promise
 * pending forever. Not a policy knob: a caller wanting a different bound supplies
 * their own `fetchImpl`, whose signal fires first. Matches the 30s default in the
 * Python sibling's `Transport`.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Header names dropped when rebuilding a `Response` from a thrown HTTP error:
 * they describe a wire encoding that no longer applies once the body has been
 * decoded and re-serialized, and a stale value confuses anything that reads
 * them back.
 */
const REBUILT_RESPONSE_DROPPED_HEADERS = new Set(['content-length', 'content-encoding']);

export abstract class BaseConnector {
  abstract readonly providerId: string;

  /**
   * The HTTP seam. **Contract: a non-2xx must be RETURNED as a `Response`, not
   * thrown** — that is plain fetch semantics, and every connector's
   * `if (!response.ok)` branch depends on it.
   *
   * Honoured defensively rather than assumed, because the effective
   * implementation is not only what the caller passes here: on Node,
   * `globalThis.fetch` dispatches through undici's *process-global* dispatcher,
   * which a host application can replace at any time
   * (`setGlobalDispatcher(new Agent().compose(interceptors.responseError()))`)
   * with no signal reaching this library. See
   * {@link responseFromThrownHttpError}.
   */
  protected readonly fetchImpl: typeof fetch;

  protected constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  // ===== Shared request helpers used by every connector =====

  protected async sendGet(
    url: string,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const finalUrl = this.buildUrl(url, options?.query);
    return this.invokeFetch(finalUrl, { method: 'GET', headers: options?.headers });
  }

  protected async sendPostJson(
    url: string,
    body: unknown,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const finalUrl = this.buildUrl(url, options?.query);
    return this.invokeFetch(finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
  }

  protected async sendPostForm(
    url: string,
    form: Record<string, string>,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const finalUrl = this.buildUrl(url, options?.query);
    return this.invokeFetch(finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options?.headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  private buildUrl(url: string, query?: Record<string, string>): string {
    if (!query) return url;
    const qs = new URLSearchParams(query).toString();
    if (qs.length === 0) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${qs}`;
  }

  private async invokeFetch(url: string, init: RequestInit): Promise<Response> {
    // `AbortSignal.timeout` uses an unref'd timer, so an in-flight request never
    // keeps a process alive. Guarded for runtimes that predate it (Node < 17.3),
    // where the request simply carries no wrapper-level bound.
    const timeoutSignal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
        : undefined;

    // Combined, not replaced: spreading `signal` after `...init` would discard a
    // caller's signal.
    const callerSignal = init.signal ?? undefined;
    const signal =
      callerSignal && timeoutSignal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : (timeoutSignal ?? callerSignal);

    try {
      // Never follow redirects: a 3xx surfaces as an error rather than silently
      // re-sending auth headers (X-Goog-Api-Key etc.) to the redirect target.
      return await this.fetchImpl(url, {
        redirect: 'error',
        ...init,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      // The provider may have answered perfectly well and the dispatcher turned
      // that answer into a rejection. Rebuilding the `Response` — rather than
      // classifying here — keeps the per-connector `mapVendorError` the single
      // owner of status→code translation, so the caller still gets the real
      // status, the vendor message and Retry-After.
      const rebuilt = responseFromThrownHttpError(err);
      if (rebuilt !== null) return rebuilt;

      // Both checks are needed. Our own signal covers runtimes that name the
      // rejection 'AbortError'; the name check covers a `fetchImpl` with a tighter
      // bound, whose `AbortSignal.any` wrapper leaves OUR signal un-aborted (an
      // `any` abort does not abort its sources). A deliberate `controller.abort()`
      // yields 'AbortError' and is not a timeout.
      const name = (err as Error)?.name;
      const timedOut = timeoutSignal?.aborted === true || name === 'TimeoutError';

      // A BYO `fetchImpl`'s error is intentionally NOT propagated verbatim: a
      // leaky implementation can embed the (key-bearing) request URL in its
      // message, which would then surface in `ConnectorError.message` /
      // `.cause` and get logged. Use a fixed message and a sanitized cause
      // carrying the error's class name plus the token-shaped diagnostic codes
      // — never its message or the raw error object.
      throw new ConnectorError({
        message: timedOut ? 'Network request timed out' : 'Network request failed',
        statusCode: null,
        providerCode: timedOut ? 'timeout' : 'provider_unavailable',
        cause: { raw: sanitizeThrownError(err) },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Walk `err`, `err.cause`, `err.cause.cause` — deep enough for a wrapped rejection. */
function* errorChain(err: unknown, depth = 3): Generator<Record<string, unknown>> {
  let current = err;
  for (let i = 0; i < depth; i++) {
    if (current === null || typeof current !== 'object') return;
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Rebuild a `Response` from a rejection that carries an HTTP status, or return
 * `null` when the rejection is a genuine transport failure.
 *
 * Fetch resolves a non-2xx; a dispatcher may reject instead. undici's
 * `interceptors.responseError()` is the one in the wild: `fetch` rejects with
 * `TypeError: fetch failed` whose `.cause` is a `ResponseError` carrying
 * `statusCode`, `headers` and a `body` that is already JSON-parsed for
 * `application/json`. Because that dispatcher is installed process-wide by the
 * *host application*, it is invisible to the `fetchImpl` handed to us — so this
 * is duck-typed on the shape, never on an `undici` import (zero runtime deps).
 *
 * The provider answered, so the answer is what the caller must see: without
 * this, every 400/429/503 from every provider collapses into
 * `provider_unavailable` with a null status.
 */
function responseFromThrownHttpError(err: unknown): Response | null {
  if (typeof Response !== 'function') return null;

  for (const link of errorChain(err)) {
    const status = link.statusCode ?? link.status;
    // Only a status a `Response` can actually carry. Anything outside the range
    // (or a 1xx) is not an HTTP answer we can faithfully reconstruct.
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
      continue;
    }

    // 204/205/304 are null-body statuses; `new Response(body, …)` throws for them.
    const body = status === 204 || status === 205 || status === 304 ? null : readErrorBody(link.body);

    try {
      return new Response(body, { status, headers: readErrorHeaders(link.headers) });
    } catch {
      // A status/body combination `Response` refuses — fall through and report
      // it as a transport failure rather than throwing something unexpected.
      return null;
    }
  }

  return null;
}

/** Normalize a buffered error body to something the `Response` constructor accepts. */
function readErrorBody(body: unknown): string | Uint8Array | ArrayBuffer | null {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
  if (body === null || body === undefined) return null;
  if (typeof body === 'object') {
    // Already-decoded JSON (undici parses `application/json` before throwing);
    // re-serialize so the connector's own `response.json()` sees it unchanged.
    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }
  return null;
}

/** Copy the string-valued headers off a thrown error, skipping stale encoding metadata. */
function readErrorHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (REBUILT_RESPONSE_DROPPED_HEADERS.has(name)) continue;
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[name] = value.join(', ');
    }
  }
  return out;
}

/**
 * A diagnostic-code shape: identifier characters only. A credential can only
 * reach `ConnectorError.cause` through a leaky `fetchImpl`, and it would arrive
 * inside a URL — which cannot match this pattern (no `/`, `:`, `?`, `=` or
 * whitespace). Length-capped so an opaque token cannot masquerade as one.
 */
const DIAGNOSTIC_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function readDiagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_CODE.test(value) ? value : undefined;
}

/**
 * The non-secret, structured fields of a transport rejection.
 *
 * `name` alone is `'TypeError'` for every undici failure — DNS, reset, TLS,
 * aborted redirect — which identifies nothing. `code` (`ECONNRESET`,
 * `UND_ERR_SOCKET`, `ENOTFOUND`, …) is the field that actually names the
 * failure, and it is a fixed vocabulary that can hold no URL or credential. The
 * message and the raw error object stay suppressed.
 */
function sanitizeThrownError(err: unknown): Record<string, unknown> {
  const raw: Record<string, unknown> = { name: (err as Error)?.name };
  const [self, cause] = [...errorChain(err, 2)];

  const code = readDiagnosticCode(self?.code) ?? readDiagnosticCode(cause?.code);
  if (code !== undefined) raw.code = code;

  const causeName = readDiagnosticCode(cause?.name);
  if (causeName !== undefined) raw.causeName = causeName;

  const statusCode = cause?.statusCode ?? self?.statusCode;
  if (typeof statusCode === 'number') raw.statusCode = statusCode;

  return raw;
}
