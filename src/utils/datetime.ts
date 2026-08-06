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
