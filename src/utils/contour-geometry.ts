import type { GeoJsonMultiPolygon, GeoJsonPolygon } from '../types';

/**
 * Twice the signed area of a ring in the `[lng, lat]` plane (shoelace formula):
 * positive when the ring runs counter-clockwise, negative when clockwise, 0 for
 * a degenerate ring. Only the sign and relative size are ever used, so the
 * planar approximation is enough — winding does not change under projection.
 */
export function ringSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1! * y2! - x2! * y1!;
  }
  return sum;
}

/**
 * A copy of `ring` whose last position equals its first, as GeoJSON requires.
 * TomTom's boundary is an open point list, so closure is enforced here for every
 * provider rather than trusted.
 */
export function closeRing(ring: number[][]): number[][] {
  const closed = ring.map((position) => [position[0]!, position[1]!]);
  if (closed.length === 0) return closed;
  const first = closed[0]!;
  const last = closed[closed.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) closed.push([first[0]!, first[1]!]);
  return closed;
}

/**
 * Normalize provider polygons (each `[exterior, ...holes]`, exterior non-empty)
 * into a contour geometry: rings closed, empty holes dropped, and winding set
 * per RFC 7946 §3.1.6 (exterior counter-clockwise, holes clockwise) — providers
 * disagree (Esri winds exteriors clockwise), and a consumer applying the
 * right-hand rule would otherwise read a hole as filled area.
 *
 * One polygon stays a `Polygon`, so the common single-area result keeps the
 * shape it always had; only a genuinely multi-part result is a `MultiPolygon`.
 */
export function toContourGeometry(
  polygons: number[][][][],
): GeoJsonPolygon | GeoJsonMultiPolygon {
  const normalized = polygons.map(([exterior, ...holes]) => [
    orient(closeRing(exterior!), 'ccw'),
    ...holes.filter((hole) => hole.length > 0).map((hole) => orient(closeRing(hole), 'cw')),
  ]);
  if (normalized.length === 1) return { type: 'Polygon', coordinates: normalized[0]! };
  return { type: 'MultiPolygon', coordinates: normalized };
}

/**
 * `ring` wound the requested way. A degenerate (zero-area) ring has no winding
 * and is returned as-is. Reversing a closed ring keeps it closed.
 */
function orient(ring: number[][], winding: 'ccw' | 'cw'): number[][] {
  const area = ringSignedArea(ring);
  if (area === 0) return ring;
  const isCcw = area > 0;
  return isCcw === (winding === 'ccw') ? ring : ring.reverse();
}
