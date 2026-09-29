/**
 * The `accumulateAttributeNames` lists the Esri routing and matrix connectors send.
 *
 * `_passthrough.body.accumulateAttributeNames` REPLACES the connector's value
 * rather than merging into it: a merge could only ever add attributes, leaving
 * no way to drop one. The connectors build the form value from these constants,
 * so a caller who wants one more accumulated attribute spreads the relevant
 * constant and appends, and the published list cannot drift from what is sent:
 *
 * ```ts
 * _passthrough: {
 *   body: { accumulateAttributeNames: [...ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING, 'Miles'].join(',') },
 * }
 * ```
 *
 * Frozen at runtime as well as `readonly` in the type, so no caller can mutate
 * the list every later request is built from.
 */

/**
 * Routing, on the service's default (driving) travel mode — every `travelMode`
 * except `'walking'`. The time attribute must match the travel mode's impedance:
 * Esri names the cumulative field after it and emits nothing for a mismatched one.
 * - `TravelTime` → `Cumul_TravelTime` per stop → `legs[].durationSeconds` and
 *   `totalDurationSeconds`
 * - `Kilometers` → `Cumul_Kilometers` per stop → `legs[].distanceMeters` and
 *   `totalDistanceMeters`
 */
export const ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING = Object.freeze([
  'TravelTime',
  'Kilometers',
] as const);

/**
 * Routing with `travelMode: 'walking'`, whose travel mode sets the impedance to
 * `WalkTime`. Same outputs as the driving list, read from `Cumul_WalkTime`.
 */
export const ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING = Object.freeze([
  'WalkTime',
  'Kilometers',
] as const);

/**
 * OD cost matrix, every travel mode. The time column comes from the impedance
 * without being accumulated, so only the distance is listed.
 * - `Kilometers` → each cell's `distanceMeters`; without it the matrix raises
 *   `unknown` (the cost columns lack `Kilometers`) rather than reporting 0 m
 */
export const ESRI_MATRIX_ACCUMULATE_ATTRIBUTES = Object.freeze(['Kilometers'] as const);
