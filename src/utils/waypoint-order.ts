/**
 * Canonical `waypointOrder` validation, shared by every routing connector that
 * derives an optimized visiting sequence.
 *
 * The canonical contract (see `IRoutingResult`) is a complete permutation of
 * `[0..N-1]` listing the INPUT waypoint indices in visit order. A vendor can
 * break that in ways a bounds check alone will not catch — a sentinel value
 * (Google returns `[-1]` when it declines to optimize), a duplicated position,
 * a short list — and the resulting array is then either wrong or holds
 * `undefined` holes while still being typed `number[]`. Consumers use
 * `waypointOrder` to reorder their own collections, so a silently wrong
 * permutation corrupts their data. Both helpers therefore reject rather than
 * repair: an ordering that is not a complete permutation is **omitted**, which
 * the contract already documents as "the vendor returned no ordering".
 *
 * Vendors express the sequence in one of two ways, hence two helpers:
 * - **Visit order** (HERE `findsequence2`, Google/TomTom after projection) —
 *   already the canonical direction; validate with {@link isCompleteWaypointOrder}.
 * - **Visit position per input** (OSRM/Mapbox `waypoint_index`, ESRI
 *   `Sequence`) — the INVERSE; invert with {@link invertWaypointPositions}.
 */

/**
 * True when `order` is a complete permutation of `[0..expectedLength-1]`:
 * correct length, integers only, all in range, no duplicates.
 *
 * Accepts `readonly unknown[]` so connectors can hand over unvalidated vendor
 * data directly.
 */
export function isCompleteWaypointOrder(
  order: readonly unknown[],
  expectedLength: number,
): boolean {
  if (order.length !== expectedLength) return false;

  const seen = new Array<boolean>(expectedLength).fill(false);
  for (const value of order) {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= expectedLength ||
      seen[value]
    ) {
      return false;
    }
    seen[value] = true;
  }

  return true;
}

/**
 * Invert vendor visit-position data into the canonical `waypointOrder`.
 *
 * `positions[i]` is the 0-based position input waypoint `i` occupies in the
 * optimized route, so the result places each input index at its visit position
 * (`order[positions[i]] = i`). Returns `undefined` when the data is absent,
 * incomplete, or malformed — never a partially-filled array.
 */
export function invertWaypointPositions(
  positions: readonly unknown[],
  expectedLength: number,
): number[] | undefined {
  if (positions.length !== expectedLength) return undefined;

  const order = new Array<number>(expectedLength);
  const filled = new Array<boolean>(expectedLength).fill(false);
  for (let inputIndex = 0; inputIndex < positions.length; inputIndex++) {
    const position = positions[inputIndex];
    if (
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      position >= expectedLength ||
      filled[position]
    ) {
      return undefined;
    }
    filled[position] = true;
    order[position] = inputIndex;
  }

  return order;
}
