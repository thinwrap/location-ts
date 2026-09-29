import type { ProviderCode } from '../../types';

/**
 * Classify an OSRM envelope `code` into a {@link ProviderCode}, or `null` when
 * the body carries no code this connector recognizes (so the caller falls back
 * to HTTP-status mapping).
 *
 * Shared by the routing and table connectors and by both of their error paths,
 * because OSRM does not distinguish them: every non-Ok code arrives with a 4xx
 * status in practice (verified live against the demo build and a self-hosted
 * instance), and the same code on a 200 means the same thing.
 *
 * - `NoRoute` / `NoSegment` / `NoTrips` → `no_route`: the request was
 *   well-formed and the server answered, there simply is no connecting route
 *   (or no road near a coordinate to snap to). A business outcome, not a bug.
 * - `InvalidQuery` / `InvalidOptions` / `InvalidValue` → `invalid_request`.
 * - `NotImplemented` → `unsupported_option`.
 *
 * A `NoRoute` whose message carries an explicit "profile not found" signal is
 * `profile_not_configured` instead — an operator error, not a missing route.
 * Missing profiles are NOT inferred from a generic `NoRoute` (too brittle).
 *
 * `NoTrips` is a `/trip` outcome only (`service === 'trip'`); anywhere else it
 * stays unclassified rather than being reported as a routing outcome.
 */
export function classifyOsrmEnvelopeCode(
  body: { code?: unknown; message?: unknown } | null,
  service: 'route' | 'trip' | 'table',
): ProviderCode | null {
  if (body === null || typeof body !== 'object') return null;
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';

  switch (code) {
    case 'NoRoute':
    case 'NoSegment':
      return message !== '' && /profile\s+not\s+found/i.test(message)
        ? 'profile_not_configured'
        : 'no_route';
    case 'NoTrips':
      return service === 'trip' ? 'no_route' : null;
    case 'InvalidQuery':
    case 'InvalidOptions':
    case 'InvalidValue':
      return 'invalid_request';
    case 'NotImplemented':
      // The server cannot honour a well-formed parameter combination — e.g. an
      // open trip with one fixed end on an OSRM build older than 5.27, or
      // source=any&destination=any with roundtrip=false forced via passthrough.
      return 'unsupported_option';
    default:
      return null;
  }
}
