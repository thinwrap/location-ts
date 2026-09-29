/**
 * The `annotations` list the Mapbox Matrix connector sends.
 *
 * Mapbox's own default is `duration` alone, which would leave every cell without
 * a distance, so the connector asks for both. It is set BEFORE the `_passthrough`
 * merge, so `_passthrough.query.annotations` REPLACES it — a caller can still
 * choose the list. Mapbox documents only `duration` and `distance` for Matrix,
 * so there is nothing further to append; the constant is published so the list
 * the connector relies on is visible and cannot drift from what is sent.
 *
 * - `duration` → each cell's `durationSeconds`
 * - `distance` → each cell's `distanceMeters`
 *
 * Both are required: a response missing either matrix fails the connector's
 * dimension check and raises `unknown` rather than returning zeroed cells.
 *
 * Frozen at runtime as well as `readonly` in the type, so no caller can mutate
 * the list every later request is built from.
 */
export const MAPBOX_MATRIX_ANNOTATIONS = Object.freeze(['duration', 'distance'] as const);
