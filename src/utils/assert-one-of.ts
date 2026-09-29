/*
 * Closed-vocabulary checks for the normalized option strings.
 *
 * Each connector TRANSLATES these values (`'walking'` becomes `WALK`,
 * `pedestrian`, a walking travel-mode object, …), so a value outside the set
 * never reaches a vendor that could reject it: unchecked, it would fall through
 * the translation's default and be sent as driving, as no traffic, as
 * simplified geometry, or as a distance isochrone. Such a value is a bug in
 * the calling code rather than bad request data, so it is a `TypeError` — never
 * a `ConnectorError`, whose `invalid_request` tells a caller to blame the input.
 * `undefined` is always accepted and keeps the option's documented default.
 *
 * The per-operation checks live in `validate-options.ts`; they run at the top
 * of each operation method, which is `async`, so they surface as a rejection
 * like every other operation failure.
 */

export const TRAVEL_MODES = ['driving', 'walking', 'cycling'] as const;
export const TRAFFIC_MODES = ['none', 'traffic', 'live'] as const;
export const POLYLINE_QUALITIES = ['simplified', 'detailed'] as const;
export const ROUTING_INCLUDE_TOKENS = ['durationWithoutTraffic'] as const;
export const PLACE_DETAILS_INCLUDE_TOKENS = ['name'] as const;
export const ISOCHRONE_TYPES = ['time', 'distance'] as const;

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'symbol') return value.toString();
  return String(value);
}

function expected(allowed: readonly string[]): string {
  return allowed.map((v) => `'${v}'`).join(', ');
}

/**
 * Throw a `TypeError` unless `value` is `undefined` or one of `allowed`.
 *
 * @throws {TypeError} when `value` is defined and not a member of `allowed`.
 */
export function assertOneOf(value: unknown, allowed: readonly string[], name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`Unknown ${name}: ${describe(value)} (expected one of ${expected(allowed)})`);
  }
}

/**
 * Throw a `TypeError` unless `value` is `undefined` or an array whose every
 * element is one of `allowed`.
 *
 * @throws {TypeError} when `value` is not an array, or holds an unknown token.
 */
export function assertTokens(value: unknown, allowed: readonly string[], name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array (received ${describe(value)})`);
  }
  for (const token of value) {
    if (typeof token !== 'string' || !allowed.includes(token)) {
      throw new TypeError(
        `Unknown ${name} token: ${describe(token)} (expected one of ${expected(allowed)})`,
      );
    }
  }
}
