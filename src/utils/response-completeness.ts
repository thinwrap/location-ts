import { ConnectorError } from '../types/error.types';

/**
 * Verify a routing response carries any route detail at all before it is handed
 * back to the caller.
 *
 * This is the connector-side answer to *"expose `waypoints[]` so I can check the
 * response is complete"*. Exporting a count would make every consumer re-derive
 * the same invariant, so the wrapper — which knows what it asked for — checks
 * instead. An empty `legs[]` for a multi-waypoint request means the response
 * arrived structurally intact but describes no journey: `totalDistanceMeters`
 * and `polyline` may still look plausible while there is nothing to iterate.
 *
 * **Why this is not an exact leg-count check.** `legs.length === waypoints - 1`
 * looks like the stronger invariant, and it is what the plan originally called
 * for, but it has a false positive that would break valid code: Mapbox and OSRM
 * both support *silent waypoints* (`waypoints=0;2`), where a coordinate is used
 * for routing without producing its own leg. A consumer setting that through
 * `_passthrough.query` is making a legitimate request whose leg count is
 * deliberately lower. There is also no live evidence of any provider returning a
 * short-but-non-empty `legs[]`, so enforcing the exact count would trade a real
 * false positive for a speculative catch. Consumers that know their own waypoint
 * semantics can still assert the exact count themselves.
 */
export function assertRouteHasLegs(
  actualLegs: number,
  waypointCount: number,
  provider: string,
  raw: unknown,
): void {
  if (actualLegs > 0 || waypointCount < 2) return;

  const message = `${provider} returned a route with no legs for ${waypointCount} waypoints`;
  throw new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'no_route',
    providerMessage: message,
    cause: raw,
  });
}
