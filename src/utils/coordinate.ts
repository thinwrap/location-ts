import type { LatLng } from '../types';
import { ConnectorError } from '../types';

/**
 * Reject NaN / non-finite coordinates before they reach the wire.
 *
 * Thin-wrapper philosophy: out-of-range (but finite) lat/lng pass through
 * verbatim — only NaN/Infinity are rejected, because they serialize to
 * garbage the provider cannot parse.
 *
 * @throws {ConnectorError} `providerCode: 'invalid_request'` on non-finite lat/lng.
 */
export function assertFiniteCoordinate(
  c: { lat: number; lng: number },
  context?: string
): void {
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
    const where = context ? ` (${context})` : '';
    throw new ConnectorError({
      message: `Coordinate lat/lng must be finite numbers${where}`,
      statusCode: null,
      providerCode: 'invalid_request',
    });
  }
}

/**
 * Format a single coordinate component as a fixed-notation decimal string,
 * never exponential.
 *
 * `String(v)` / template interpolation renders `0 < |v| < 1e-6` in exponential
 * notation (e.g. `String(0.0000003) === '3e-7'`), which providers reject or
 * misparse on the wire. This mirrors the Go sibling's
 * `strconv.FormatFloat(f, 'f', -1, 64)` shortest-fixed-point behavior.
 *
 * Ordinary coordinates and integers are returned byte-identical to `String(v)`:
 * `String(v)` is already the shortest round-tripping decimal and only reaches
 * exponential form outside the coordinate range, so the fast path returns it
 * verbatim. The exponential fallback expands the shortest mantissa/exponent
 * lexically (no re-rounding), so the value still round-trips.
 */
export function formatCoord(v: number): string {
  const s = String(v);
  const eIndex = s.indexOf('e');
  if (eIndex === -1) return s;

  const sign = s[0] === '-' ? '-' : '';
  const unsigned = sign ? s.slice(1) : s;
  const [mantissa, expPart] = unsigned.split('e');
  const exp = parseInt(expPart as string, 10);
  const dot = (mantissa as string).indexOf('.');
  const intDigits = dot === -1 ? (mantissa as string) : (mantissa as string).slice(0, dot);
  const fracDigits = dot === -1 ? '' : (mantissa as string).slice(dot + 1);
  const digits = intDigits + fracDigits;
  // Position of the decimal point measured from the left of `digits`.
  const pointPos = intDigits.length + exp;

  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  if (out.includes('.')) {
    out = out.replace(/0+$/, '').replace(/\.$/, '');
  }
  return sign + out;
}

/** Format as "lng,lat" for OSRM/Mapbox */
export function toLngLatString(coord: LatLng): string {
  assertFiniteCoordinate(coord, 'toLngLatString');
  return `${formatCoord(coord.lng)},${formatCoord(coord.lat)}`;
}

/** Format as "lat,lng" for HERE/Google */
export function toLatLngString(coord: LatLng): string {
  assertFiniteCoordinate(coord, 'toLatLngString');
  return `${formatCoord(coord.lat)},${formatCoord(coord.lng)}`;
}

/** Join an array of coordinates into a delimited string */
export function joinCoords(
  coords: LatLng[],
  format: 'lnglat' | 'latlng',
  separator: string
): string {
  for (const coord of coords) {
    assertFiniteCoordinate(coord, 'joinCoords');
  }
  const fn = format === 'lnglat' ? toLngLatString : toLatLngString;
  return coords.map(fn).join(separator);
}
