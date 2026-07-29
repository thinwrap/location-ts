import { describe, it, expect } from 'vitest';
import { isCompleteWaypointOrder, invertWaypointPositions } from './waypoint-order';

describe('isCompleteWaypointOrder', () => {
  it('accepts a complete permutation', () => {
    expect(isCompleteWaypointOrder([0, 2, 1, 3], 4)).toBe(true);
  });

  it('accepts the identity ordering', () => {
    expect(isCompleteWaypointOrder([0, 1, 2], 3)).toBe(true);
  });

  it('accepts a zero-length ordering against a zero expected length', () => {
    expect(isCompleteWaypointOrder([], 0)).toBe(true);
  });

  it('rejects a short ordering', () => {
    expect(isCompleteWaypointOrder([0, 1, 2], 4)).toBe(false);
  });

  it('rejects a long ordering', () => {
    expect(isCompleteWaypointOrder([0, 1, 2, 3], 3)).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(isCompleteWaypointOrder([0, 1, 1, 3], 4)).toBe(false);
  });

  // Google answers `[-1]` when it declines to optimize; projected to absolute
  // input indices that becomes [0, 0, N-1] — the exact shape the consumer
  // reported as corrupting their reordering.
  it('rejects the Google [-1]-sentinel projection', () => {
    expect(isCompleteWaypointOrder([0, 0, 3], 4)).toBe(false);
  });

  it('rejects a negative index', () => {
    expect(isCompleteWaypointOrder([0, -1, 2], 3)).toBe(false);
  });

  it('rejects an out-of-range index', () => {
    expect(isCompleteWaypointOrder([0, 1, 9], 3)).toBe(false);
  });

  it('rejects a non-integer index', () => {
    expect(isCompleteWaypointOrder([0, 1.5, 2], 3)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isCompleteWaypointOrder([0, Number.NaN, 2], 3)).toBe(false);
  });

  it.each([
    ['a string index', ['0', 1, 2]],
    ['a null index', [0, null, 2]],
    ['an undefined index', [0, undefined, 2]],
    ['an object index', [0, {}, 2]],
  ])('rejects %s', (_label, order) => {
    expect(isCompleteWaypointOrder(order, 3)).toBe(false);
  });
});

describe('invertWaypointPositions', () => {
  it('inverts visit positions into the canonical visiting order', () => {
    // Input waypoint 0 is visited 1st, waypoint 1 is visited 3rd, waypoint 2
    // is visited 2nd ⇒ visiting order is [0, 2, 1].
    expect(invertWaypointPositions([0, 2, 1], 3)).toEqual([0, 2, 1]);
  });

  it('is a true inverse, not a copy', () => {
    // positions [0, 2, 3, 1] means waypoint 1 is visited last and waypoint 3
    // is visited 2nd ⇒ [0, 3, 1, 2], which differs from the input.
    expect(invertWaypointPositions([0, 2, 3, 1], 4)).toEqual([0, 3, 1, 2]);
  });

  it('inverts the identity to the identity', () => {
    expect(invertWaypointPositions([0, 1, 2, 3], 4)).toEqual([0, 1, 2, 3]);
  });

  it('returns undefined for a truncated positions array', () => {
    expect(invertWaypointPositions([0, 1], 3)).toBeUndefined();
  });

  it('returns undefined for a longer-than-expected positions array', () => {
    expect(invertWaypointPositions([0, 1, 2, 3], 3)).toBeUndefined();
  });

  // The previous per-connector implementations bounds-checked but did not
  // track duplicates, so a repeated position left an `undefined` hole in an
  // array still typed `number[]`.
  it('returns undefined for duplicate positions instead of leaving a hole', () => {
    expect(invertWaypointPositions([0, 0, 2], 3)).toBeUndefined();
  });

  it('returns undefined for a negative position', () => {
    expect(invertWaypointPositions([0, -1, 2], 3)).toBeUndefined();
  });

  it('returns undefined for an out-of-range position', () => {
    expect(invertWaypointPositions([0, 1, 3], 3)).toBeUndefined();
  });

  it('returns undefined for a non-integer position', () => {
    expect(invertWaypointPositions([0, 1.5, 2], 3)).toBeUndefined();
  });

  it.each([
    ['a string position', ['0', 1, 2]],
    ['a null position', [0, null, 2]],
    ['an undefined position', [0, undefined, 2]],
  ])('returns undefined for %s', (_label, positions) => {
    expect(invertWaypointPositions(positions, 3)).toBeUndefined();
  });

  it('never returns an array containing undefined', () => {
    const result = invertWaypointPositions([2, 0, 1], 3);
    expect(result).toEqual([1, 2, 0]);
    expect(result?.every((v) => typeof v === 'number')).toBe(true);
  });
});
