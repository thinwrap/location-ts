/**
 * The `X-Goog-FieldMask` lists the Google connectors send.
 *
 * `_passthrough.headers['X-Goog-FieldMask']` REPLACES the connector's mask
 * rather than merging into it: a merge could only ever add fields, leaving no way
 * to drop one. These constants are what the connectors build their masks from, so
 * a caller who wants one extra field spreads the relevant constant and appends to
 * it, and the published list cannot drift from what is actually sent:
 *
 * ```ts
 * _passthrough: {
 *   headers: {
 *     'X-Goog-FieldMask': [...GOOGLE_ROUTES_FIELD_MASK, 'routes.travelAdvisory'].join(','),
 *   },
 * }
 * ```
 *
 * Every field listed is one the normalizer reads; leaving one out of a
 * replacement mask makes Google omit it, and the matching normalized output
 * comes back empty or zero — or the call fails where an empty value would be
 * a fabricated answer (no legs on a multi-waypoint route, no cell indexes).
 *
 * Frozen at runtime as well as `readonly` in the type, so no caller can mutate
 * the list every later request is built from.
 */

/**
 * Compute Routes base mask, always sent.
 * - `routes.legs.distanceMeters` / `routes.legs.duration` → `legs[]`
 * - `routes.distanceMeters` / `routes.duration` → `totalDistanceMeters` / `totalDurationSeconds`
 * - `routes.polyline.encodedPolyline` → `polyline`
 */
export const GOOGLE_ROUTES_FIELD_MASK = Object.freeze([
  'routes.legs.distanceMeters',
  'routes.legs.duration',
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
] as const);

/**
 * Appended to {@link GOOGLE_ROUTES_FIELD_MASK} when `include` contains
 * `'durationWithoutTraffic'`; feeds `legs[].durationWithoutTrafficSeconds` and
 * `totalDurationWithoutTrafficSeconds`. Adding these fields by passthrough alone
 * surfaces nothing: the outputs also follow the `include` token.
 */
export const GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC = Object.freeze([
  'routes.legs.staticDuration',
  'routes.staticDuration',
] as const);

/**
 * Appended to {@link GOOGLE_ROUTES_FIELD_MASK} when the request asks for
 * reordering — any of `optimize`, `optimizeFixedOrigin`,
 * `optimizeFixedDestination` or `isRoundTrip`; feeds `waypointOrder`.
 */
export const GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER = Object.freeze([
  'routes.optimizedIntermediateWaypointIndex',
] as const);

/**
 * Compute Route Matrix mask, always sent (no conditional groups).
 * - `originIndex` / `destinationIndex` → the cell's position; without them the
 *   cells carry no indices and cannot be placed in the matrix
 * - `distanceMeters` / `duration` → `distanceMeters` / `durationSeconds`
 * - `status` / `condition` → drop failed elements; without them an unroutable
 *   pair is reported as a zero-distance, zero-duration cell
 */
export const GOOGLE_MATRIX_FIELD_MASK = Object.freeze([
  'originIndex',
  'destinationIndex',
  'distanceMeters',
  'duration',
  'status',
  'condition',
] as const);

/**
 * Place Details (Places API New) base mask, always sent. The mask selects the
 * SKU tier, so the base stays on Essentials fields.
 * - `id` → `candidate.placeId`
 * - `formattedAddress` → `candidate.formattedAddress`
 * - `location` → `candidate.location`; without it the call throws `no_route`
 *   rather than fabricating a (0,0) location
 * - `viewport` → `candidate.viewport`
 */
export const GOOGLE_PLACE_DETAILS_FIELD_MASK = Object.freeze([
  'id',
  'formattedAddress',
  'location',
  'viewport',
] as const);

/**
 * Appended to {@link GOOGLE_PLACE_DETAILS_FIELD_MASK} when `include` contains
 * `'name'`. `displayName` is a Pro-tier field, which is why it is opt-in; like the
 * static durations above, `name` also follows the `include` token.
 */
export const GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME = Object.freeze([
  'displayName',
] as const);
