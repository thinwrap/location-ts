import { ConnectorError } from '../types/error.types';

/**
 * Default per-request bound, so a hung provider cannot leave the caller's promise
 * pending forever. Not a policy knob: a caller wanting a different bound supplies
 * their own `fetchImpl`, whose signal fires first. Matches the 30s default in the
 * Python sibling's `Transport`.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export abstract class BaseConnector {
  abstract readonly providerId: string;
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
      // carrying only the error's class name, never its message or the raw
      // error object.
      throw new ConnectorError({
        message: timedOut ? 'Network request timed out' : 'Network request failed',
        statusCode: null,
        providerCode: timedOut ? 'timeout' : 'provider_unavailable',
        cause: { raw: { name } },
      });
    }
  }
}
