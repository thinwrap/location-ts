import { ConnectorError } from '../../types';
import type { OsrmConfig } from './osrm.config';

/**
 * Validate and normalize an OSRM `baseUrl`, raising a typed
 * {@link ConnectorError} (`providerCode: 'invalid_request'`, `statusCode: null`)
 * before any HTTP work. Shared by the routing and matrix connectors — OSRM is
 * the only provider requiring an explicit base URL and shipping zero auth, so
 * there is no default to fall back to (the public demo server is deliberately
 * not one).
 *
 * Two checks:
 * - **Present and non-empty**, so a missing self-host address fails loudly
 *   rather than producing a relative URL.
 * - **`http://` or `https://` scheme.** Without it a bare host like
 *   `router.example.com` reaches `fetch()` as a relative URL, which rejects with
 *   `TypeError: Invalid URL`. `BaseConnector` catches that and — correctly, for a
 *   transport failure — reports `provider_unavailable` behind a sanitized
 *   message, so a one-character config typo was indistinguishable from the
 *   server being down. Checking here makes it an `invalid_request` that names
 *   the actual problem.
 *
 * A path prefix is explicitly ALLOWED — hosting OSRM under `https://host/osrm`
 * behind a reverse proxy is a normal deployment. Trailing slashes are stripped
 * so the caller's `${baseUrl}/route/v1/...` concatenation cannot produce a
 * double slash.
 */
export function validateOsrmBaseUrl(config: OsrmConfig | null | undefined): string {
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

  if (!/^https?:\/\//i.test(config.baseUrl)) {
    throw new ConnectorError({
      message: `OSRM baseUrl must start with http:// or https:// (got: ${redactUserinfo(config.baseUrl)})`,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: 'OSRM baseUrl must start with http:// or https://',
    });
  }

  return config.baseUrl.replace(/\/+$/, '');
}

/**
 * Replace a URL's userinfo (`user:pass@`) with `***` so a credential embedded
 * in `baseUrl` — the usual way to reach an OSRM behind basic-auth — never lands
 * in an error message or a log line.
 *
 * Deliberately not `new URL()`: the value being echoed is the one that failed
 * the scheme check, so it may be scheme-less (`user:pass@host`) or malformed
 * (`https:/user:pass@host`). Everything between the scheme's slashes (or the
 * start) and the LAST `@` is masked — over-redacting an `@` that sat in a path
 * is harmless in an error message; under-redacting a password is not.
 */
export function redactUserinfo(url: string): string {
  const at = url.lastIndexOf('@');
  if (at < 0) return url;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/+/.exec(url);
  const start = scheme !== null ? scheme[0].length : 0;
  if (start > at) return url;
  return `${url.slice(0, start)}***${url.slice(at)}`;
}
