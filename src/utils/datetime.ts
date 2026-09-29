import { ConnectorError } from '../types';

/**
 * ISO 8601 at *seconds* precision, zone designator retained
 * (`2026-08-07T03:06:00Z`).
 *
 * `Date.prototype.toISOString()` always emits milliseconds, and not every
 * endpoint accepts them. Precision is a property of the endpoint, not of the
 * value — so this is used only where the vendor's documented grammar stops at
 * seconds, and the fractional form stays wherever it is accepted:
 *
 * - HERE `findsequence2` — live-verified: `…T03:06:00.000Z` answers HTTP 400
 *   `Bad Format for Date and Time`, `…T03:06:00Z` answers 200. HERE documents
 *   the parameter as `xs:dateTime` and its own example carries no fraction.
 * - Mapbox Directions `depart_at` — documented as one of exactly three ISO 8601
 *   forms (`YYYY-MM-DDThh:mm:ssZ`, `YYYY-MM-DDThh:mm:ss±hh:mm`,
 *   `YYYY-MM-DDThh:mm`); a millisecond value is not among them.
 *
 * Sub-second input is truncated rather than rounded, so the emitted instant is
 * never later than the one the caller asked for.
 */
export function toIsoSeconds(when: Date): string {
  return `${when.toISOString().slice(0, 19)}Z`;
}

/**
 * Check a caller-supplied `departureTime` before any wire work.
 *
 * - Not a `Date` at all (a string, an epoch number) is a bug in the calling
 *   code: the type says `Date`, so it is a `TypeError`.
 * - An invalid `Date` (`new Date('garbage')`) is bad runtime data, typically a
 *   time parsed from user input. Left alone, `toISOString()` throws a native
 *   `RangeError: Invalid time value` from inside the connector, and an epoch
 *   conversion sends `NaN`; it is a `ConnectorError` with `invalid_request`
 *   instead, the error a vendor answers garbage with.
 *
 * Every routing and matrix connector calls this at the top of the operation,
 * including where the time is then dropped (`trafficMode: 'none'` on some
 * providers, walking, OSRM), so whether a bad value fails does not depend on
 * the provider or on other options.
 *
 * @param context Names the connector for the error message.
 * @throws {TypeError} when `when` is not a `Date`.
 * @throws {ConnectorError} `providerCode: 'invalid_request'` for an invalid `Date`.
 */
export function assertValidDate(when: unknown, context: string): Date {
  // Not `instanceof`: a Date from another realm (a vm context, an iframe) is
  // still a Date.
  if (Object.prototype.toString.call(when) !== '[object Date]') {
    const received = typeof when === 'string' ? JSON.stringify(when) : typeof when;
    throw new TypeError(`${context}: departureTime must be a Date (received ${received})`);
  }
  const date = when as Date;
  if (Number.isNaN(date.getTime())) {
    const message = `${context}: departureTime is not a valid date`;
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: message,
    });
  }
  return date;
}
