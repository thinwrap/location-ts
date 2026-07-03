import { ConnectorError } from '../types/error.types';

export abstract class BaseConnector {
  abstract readonly providerId: string;
  protected readonly fetchImpl: typeof fetch;

  protected constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  // ===== Canonical post-1.3 surface (used by per-connector stories 1.6-1.29) =====

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
    try {
      // Never follow redirects: a 3xx surfaces as an error rather than silently
      // re-sending auth headers (X-Goog-Api-Key etc.) to the redirect target.
      return await this.fetchImpl(url, { redirect: 'error', ...init });
    } catch (err) {
      throw new ConnectorError({
        message: (err as Error)?.message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: err,
      });
    }
  }
}
