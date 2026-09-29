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
  statusCode: number | null = null,
): void {
  if (actualLegs > 0 || waypointCount < 2) return;

  const message = `${provider} returned a route with no legs for ${waypointCount} waypoints`;
  throw new ConnectorError({
    message,
    statusCode,
    providerCode: 'no_route',
    providerMessage: message,
    cause: raw,
  });
}

/**
 * The error for a 2xx body the connector cannot interpret: a missing or
 * mistyped field, a `null` where an object belongs, a list that is not a list.
 *
 * Returning a zero-valued or empty result instead would hand the caller data
 * the provider never sent, and letting the access throw would leak a raw
 * `TypeError` outside the `ConnectorError` contract. `unknown` because no
 * `ProviderCode` means "malformed provider body"; `cause` carries the body so
 * the caller can see what actually arrived.
 */
export function malformedResponseError(
  provider: string,
  detail: string,
  statusCode: number | null,
  raw: unknown,
): ConnectorError {
  const message = `${provider} returned a malformed response: ${detail}`;
  return new ConnectorError({
    message,
    statusCode,
    providerCode: 'unknown',
    providerMessage: message,
    cause: raw,
  });
}

/**
 * The list at `value`, `[]` when the field is absent, or `null` when it is
 * present but not an array — the caller turns `null` into
 * {@link malformedResponseError}. Keeps "the provider found nothing" (absent or
 * `[]`) apart from "the provider sent something we cannot read".
 */
export function optionalArray(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

/** Whether `value` is a non-null, non-array object whose fields can be read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `value` is a finite number (the only shape a distance/duration may take). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether `value` is a usable polygon ring: at least one position, and every
 * position a pair of finite numbers. A missing coordinate must never be read
 * as 0, so a ring with one is unusable as a whole.
 */
export function isUsableRing(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (position) =>
        Array.isArray(position) &&
        position.length >= 2 &&
        isFiniteNumber(position[0]) &&
        isFiniteNumber(position[1]),
    )
  );
}

/**
 * GeoJSON Polygon `coordinates` reduced to what is usable: the exterior ring
 * plus every usable hole, or `null` when the exterior itself is unusable (a
 * polygon without one describes no area). An unusable hole is dropped rather
 * than failing the contour — losing a hole overstates the area slightly, while
 * refusing the response would lose the whole isochrone.
 */
export function usablePolygon(value: unknown): number[][][] | null {
  if (!Array.isArray(value) || !isUsableRing(value[0])) return null;
  const [exterior, ...holes] = value as unknown[];
  return [exterior as number[][], ...holes.filter(isUsableRing)];
}
