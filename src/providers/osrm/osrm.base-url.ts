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
      message: `OSRM baseUrl must start with http:// or https:// (got: ${config.baseUrl})`,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: 'OSRM baseUrl must start with http:// or https://',
    });
  }

  return config.baseUrl.replace(/\/+$/, '');
}
