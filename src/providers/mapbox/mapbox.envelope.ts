import type { ProviderCode } from '../../types';

/**
 * Classify a Mapbox Navigation envelope `code` (Directions, Optimization,
 * Matrix), or `null` for a code this table does not know — the caller then
 * applies its own status-based default.
 *
 * Shared because Mapbox uses one vocabulary across those APIs and sends it on
 * two statuses: HTTP 200 (Matrix documents `NoRoute` there) and HTTP 422 (both
 * the no-route envelope and request validation, e.g. `InvalidInput`). The
 * code, not the status, is what separates a routing outcome from a bad request.
 *
 * - `NoRoute` / `NoTrips` / `NoSegment` → `no_route`: well-formed request, no
 *   connecting route (or no road to snap to) — a business outcome.
 * - `InvalidInput` / `ProfileNotFound` → `invalid_request`.
 * - `NotImplemented` → `unsupported_option`: Optimization v1's answer for a
 *   source/destination/roundtrip combination it does not implement.
 * - `ProcessingError` → `unknown`: Mapbox failing on a valid request.
 */
export function classifyMapboxEnvelopeCode(code: unknown): ProviderCode | null {
  switch (code) {
    case 'NoRoute':
    case 'NoTrips':
    case 'NoSegment':
      return 'no_route';
    case 'InvalidInput':
    case 'ProfileNotFound':
      return 'invalid_request';
    case 'NotImplemented':
      return 'unsupported_option';
    case 'ProcessingError':
      return 'unknown';
    default:
      return null;
  }
}

/**
 * The `providerMessage` text with parsed Retry-After seconds woven in; the raw
 * header rides on `cause.retryAfter` instead of a structured field.
 */
export function withRetryAfter(base: string | null, retryAfter: string | null): string | null {
  if (retryAfter !== null && retryAfter !== '') {
    const seconds = parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) {
      const suffix = `retry after ${seconds} seconds`;
      return base !== null && base !== '' ? `${base}; ${suffix}` : suffix;
    }
  }
  return base;
}
