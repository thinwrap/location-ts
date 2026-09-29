import type { ProviderCode } from '../../types';

/*
 * Google's structured error reasons, shared by every Google connector.
 *
 * Google answers HTTP 400 `INVALID_ARGUMENT` for an invalid API key (live on
 * Routes, Route Matrix AND Places (New) autocomplete) — the same status as a
 * malformed request — so only `error.details[].reason` tells "bad key" from
 * "bad request". Reading it in one place keeps the three connectors from
 * drifting apart on which reasons mean auth.
 */

/**
 * Read the machine-readable reason from a `google.rpc.ErrorInfo` entry in
 * `error.details[]` (domain `googleapis.com`). This is a stable enum from
 * `google/api/error_reason.proto`, unlike the human `message`.
 */
export function readGoogleErrorReason(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || !('error' in body)) return null;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== 'object' || !('details' in err)) return null;
  const details = (err as { details?: unknown }).details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (d === null || typeof d !== 'object') continue;
    const domain = (d as { domain?: unknown }).domain;
    const type = (d as { '@type'?: unknown })['@type'];
    const isErrorInfo =
      domain === 'googleapis.com' ||
      (typeof type === 'string' && type.endsWith('google.rpc.ErrorInfo'));
    if (!isErrorInfo) continue;
    const reason = (d as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  return null;
}

const GOOGLE_AUTH_REASONS = new Set<string>([
  'API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED',
  'CREDENTIALS_MISSING', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'ACCOUNT_STATE_INVALID', 'CONSUMER_INVALID',
  'CONSUMER_SUSPENDED', 'USER_PROJECT_DENIED', 'SERVICE_DISABLED', 'BILLING_DISABLED',
]);
const GOOGLE_RATE_REASONS = new Set<string>(['RATE_LIMIT_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED']);

/**
 * Map a `google.rpc.ErrorInfo` reason to a canonical {@link ProviderCode}, or
 * `null` to fall back to the HTTP-status mapping.
 */
export function mapGoogleReason(reason: string | null): ProviderCode | null {
  if (reason === null) return null;
  if (GOOGLE_AUTH_REASONS.has(reason)) return 'auth_failed';
  if (GOOGLE_RATE_REASONS.has(reason)) return 'rate_limited';
  return null;
}
