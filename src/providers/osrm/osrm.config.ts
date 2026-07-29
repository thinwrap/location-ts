/**
 * OSRM exclude class, as compiled into a specific OSRM build's profile.
 *
 * Whether a class is accepted is a property of the OPERATOR'S SERVER, not of
 * OSRM — which is why it has to be declared rather than assumed. Verified live
 * on two builds that answer the same request differently: `exclude=toll` is
 * rejected with `InvalidValue` by the public demo build, and honoured by a
 * self-hosted instance where it genuinely changed the route (138075 m / 5890 s
 * via the toll road → 130421 m / 6513 s without it).
 */
export type OsrmExcludeClass = 'toll' | 'ferry' | 'motorway';

export interface OsrmConfig {
  baseUrl: string;

  /**
   * Exclude classes this OSRM build accepts, if any.
   *
   * Stock OSRM compiles no exclude classes, so by default the connector rejects
   * `avoidTolls` / `avoidFerries` / `avoidHighways` up front with
   * `unsupported_option` — better than sending a request the server will reject
   * with an opaque `InvalidValue`.
   *
   * If your profile was built with exclude classes (e.g. `toll`), list them here
   * and the matching avoid-flags start working:
   *
   * ```ts
   * new Routing('osrm', {
   *   baseUrl: 'https://routing.internal',
   *   supportedExcludeClasses: ['toll', 'ferry'],
   * });
   * ```
   *
   * Declared here rather than probed because there is no way to ask an OSRM
   * server what it supports without issuing a request that fails, and the
   * wrapper holds no state to cache such a probe in.
   */
  supportedExcludeClasses?: OsrmExcludeClass[];
}
