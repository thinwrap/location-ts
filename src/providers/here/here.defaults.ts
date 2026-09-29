/**
 * The `return` list the HERE Routing v8 connector sends.
 *
 * `_passthrough.query.return` REPLACES it rather than merging into it: a merge
 * could only ever add values, leaving no way to drop one. The connector builds
 * its `return` from this constant, so a caller who wants one more value spreads
 * it and appends, and the published list cannot drift from what is sent:
 *
 * ```ts
 * _passthrough: { query: { return: [...HERE_ROUTING_RETURN, 'turnByTurnActions'].join(',') } }
 * ```
 *
 * - `polyline` → `polyline`; without it the result's polyline is empty
 * - `summary` → `legs[]`, `totalDistanceMeters`, `totalDurationSeconds` and the
 *   `durationWithoutTraffic` outputs; without it they are all zero or absent
 *
 * Frozen at runtime as well as `readonly` in the type, so no caller can mutate
 * the list every later request is built from.
 */
export const HERE_ROUTING_RETURN = Object.freeze(['polyline', 'summary'] as const);

/**
 * The `matrixAttributes` body list the HERE Matrix v8 connector submits.
 *
 * `_passthrough.body.matrixAttributes` REPLACES it: the body deep-merge merges
 * objects but replaces arrays whole, for the same reason as `return` above. The
 * connector submits a copy of this constant.
 *
 * - `travelTimes` → each cell's `durationSeconds`
 * - `distances` → each cell's `distanceMeters`
 *
 * Both are required: a response missing either array fails the connector's
 * dimension check and raises `unknown` rather than returning zeroed cells.
 */
export const HERE_MATRIX_ATTRIBUTES = Object.freeze(['travelTimes', 'distances'] as const);
