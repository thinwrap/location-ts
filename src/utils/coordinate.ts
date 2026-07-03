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

/** Format as "lng,lat" for OSRM/Mapbox */
export function toLngLatString(coord: LatLng): string {
  assertFiniteCoordinate(coord, 'toLngLatString');
  return `${coord.lng},${coord.lat}`;
}

/** Format as "lat,lng" for HERE/Google */
export function toLatLngString(coord: LatLng): string {
  assertFiniteCoordinate(coord, 'toLatLngString');
  return `${coord.lat},${coord.lng}`;
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
