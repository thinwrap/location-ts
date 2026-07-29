import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Geometry fidelity for the returned `polyline`.
 *
 * `'simplified'` is the default because the difference is large and one-sided:
 * measured on a single ~140km route, Mapbox returned 203 characters simplified
 * versus 6146 full (30x), OSRM 155 versus 4873 (31x), and Google 883 versus 2565
 * (2.9x) — with every leg distance and duration byte-identical. Most consumers
 * draw the line on a map at zoom levels where the extra vertices are invisible,
 * so paying a 30x payload for them by default is the wrong trade.
 *
 * Opt up to `'detailed'` when the geometry itself is the product (turn-level
 * rendering, map-matching, distance-along-line math).
 *
 * **Not every provider has this knob**, and that is deliberately not an error —
 * see the note on {@link IRoutingOptions.polylineQuality}.
 */
export type PolylineQuality = 'simplified' | 'detailed';

/**
 * How much traffic data a route should be computed against.
 *
 * `'none'` is the default, and that default is a **billing** decision as much as
 * a correctness one: on Google, traffic-aware routing is a Pro-tier SKU feature
 * while the base tier is Essentials, so a wrapper that quietly turns traffic on
 * moves the consumer to a more expensive SKU. Traffic is therefore always opt-in.
 *
 * - `'none'` — free-flow / historical-free routing.
 * - `'live'` — use current traffic conditions where the provider supports it.
 *
 * Pair with `departureTime` for a future departure. Note that on providers where
 * a departure time alone implies traffic, `trafficMode` still governs: the
 * connector will not upgrade the request on your behalf.
 */
export type TrafficMode = 'none' | 'live';

/**
 * Opt-in tokens for optional normalized output fields.
 *
 * Nothing extra is fetched unless it is named here. Each token maps **1:1 onto
 * one optional field** of {@link IRoutingResult} / {@link IRoutingLeg} — that
 * 1:1 rule is what keeps this from degenerating into a second `_passthrough`.
 * If a piece of vendor data has no normalized field, it does not get a token;
 * read it from `raw` instead.
 *
 * | Token | Populates | Cost |
 * |---|---|---|
 * | `'durationWithoutTraffic'` | `IRoutingLeg.durationWithoutTrafficSeconds`, `IRoutingResult.totalDurationWithoutTrafficSeconds` | free on Google/HERE/Mapbox/OSRM; TomTom needs an extra request parameter |
 */
export type RoutingInclude = 'durationWithoutTraffic';

/**
 * Routing input options.
 *
 * A consumer can compute a route via
 * `new Routing(providerId, cfg).route(input)`.
 *
 * Per-provider augmentation: providers extend this via {@link RoutingOptionsMap}
 * (TS module augmentation) — HERE adds `transportMode` for its extra vehicle
 * classes.
 *
 * @see RoutingOptionsMap
 * @see RoutingOptionsFor
 */
export interface IRoutingOptions {
  waypoints: LatLng[];
  optimize?: boolean;
  optimizeFixedOrigin?: boolean;
  optimizeFixedDestination?: boolean;
  isRoundTrip?: boolean;
  departureTime?: Date;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  avoidHighways?: boolean;
  travelMode?: 'driving' | 'walking' | 'cycling';

  /**
   * Geometry fidelity of the returned `polyline`. Defaults to `'simplified'`.
   *
   * **A best-effort hint, not a guarantee.** Google, Mapbox and OSRM each expose
   * a fidelity control and honour both values. HERE and TomTom have none, and
   * Esri offers only a generalization *tolerance* in map units — mapping
   * `'simplified'` onto some chosen tolerance would mean inventing a magic
   * number, so it is not done. On those three the option is **silently ignored**
   * and you get their native geometry.
   *
   * Silently ignoring is the right shape here (rather than throwing
   * `unsupported_option`) because fidelity is cosmetic: getting more vertices
   * than asked for cannot make a caller's result wrong. Contrast `avoidTolls`,
   * whose silent omission WOULD change routing semantics and therefore does
   * throw. Precedent: `IAutocompleteOptions.radius` is likewise documented as
   * ignored by Mapbox and Esri.
   */
  polylineQuality?: PolylineQuality;

  /**
   * Whether to route against live traffic. Defaults to `'none'`.
   *
   * Opt-in because traffic is a billable upgrade on some providers — most
   * notably Google, where it selects a Pro-tier SKU. Providers with no traffic
   * control ignore it.
   */
  trafficMode?: TrafficMode;

  /**
   * Optional normalized output fields to fetch. Defaults to `[]` — nothing extra
   * is requested, so the response stays as small and as cheap as the provider
   * allows.
   *
   * @see RoutingInclude
   */
  include?: RoutingInclude[];

  _passthrough?: Passthrough;
}

/**
 * A single leg of a Routing response (from one waypoint to the next).
 *
 * Distances normalized to meters; durations normalized to seconds.
 */
export interface IRoutingLeg {
  distanceMeters: number;
  durationSeconds: number;

  /**
   * Leg duration ignoring traffic, in seconds. Present only when
   * `include: ['durationWithoutTraffic']` was requested AND the provider
   * returned it natively — **never synthesized**, so its absence is meaningful:
   * it means this provider did not supply the value for this request.
   *
   * The point of having it alongside `durationSeconds` is the delta: the two
   * together tell you how much of a trip's time is congestion, which is what
   * makes ETA-vs-baseline comparisons possible without a second request.
   *
   * Native support: Google (`staticDuration`), HERE (`baseDuration`), TomTom
   * (`noTrafficTravelTimeInSeconds`, requires `computeTravelTimeFor=all`).
   * Mapbox, OSRM and Esri do not return it, so it stays absent there.
   */
  durationWithoutTrafficSeconds?: number;
}

/**
 * Normalized Routing result.
 *
 * `polyline` is a Google-precision-5 encoded polyline, matching the
 * `encodePolyline` output contract.
 *
 * `legs[]` is non-empty for any successful route. Multi-waypoint routes with
 * optimization expose the optimized visiting sequence via `waypointOrder`.
 *
 * **Canonical `waypointOrder` contract (cross-language, locked):** an array
 * listing the INPUT waypoint indices in the order they are visited (the
 * optimized visiting sequence), 0-based, **including all waypoints** (origin
 * and destination inclusive). For input waypoints `[A,B,C,D]` whose optimal
 * visiting order is `A,C,B,D`, `waypointOrder` is `[0,2,1,3]`. Every routing
 * connector normalizes its vendor's native representation (inverse
 * permutations, intermediate-only lists, two-element pairs, etc.) to THIS
 * shape, guaranteeing identical output across providers and the location-php
 * sibling. Omitted when no optimization was requested or the vendor returned
 * no ordering.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 */
export interface IRoutingResult {
  legs: IRoutingLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  polyline: string;
  waypointOrder?: number[];

  /**
   * Whole-route duration ignoring traffic, in seconds. Same contract as
   * {@link IRoutingLeg.durationWithoutTrafficSeconds}: opt-in via
   * `include: ['durationWithoutTraffic']`, vendor-native only, never synthesized
   * and never summed from the legs.
   */
  totalDurationWithoutTrafficSeconds?: number;

  raw: unknown;
}

/**
 * Connector contract implemented by every per-provider Routing connector class
 * (e.g. `GoogleRoutingConnector`). Public, because consumers may implement it to
 * bring their own connector — so its shape is a breaking-change surface.
 *
 * `providerId` is typed as `string` rather than `RoutingProvider` so such a
 * consumer can pass an id this package has never heard of. Per-connector classes
 * narrow it via `readonly providerId = 'google';`.
 */
export interface IRoutingConnector {
  readonly providerId: string;
  route(options: IRoutingOptions): Promise<IRoutingResult>;
}

/**
 * Provider-specific Routing input augmentations. Keyed by provider id; providers
 * that add nothing are absent and fall back to {@link IRoutingOptions} via
 * {@link RoutingOptionsFor}.
 *
 * Augmentations are declared in `src/providers/<id>/<id>.config.ts`, **not** in
 * `<id>.types.ts`. A `declare module` block only applies when the file declaring it
 * is part of the consumer's compilation: config modules are reachable because their
 * types are re-exported from the package entry, while `<id>.types.ts` is imported by
 * nothing in the emitted type graph. An augmentation declared there resolves inside
 * this repo and is silently missing from the published package.
 *
 * @example HERE's extra vehicle classes (`src/providers/here/here.config.ts`):
 * ```ts
 * declare module '../../types/routing.interface' {
 *   interface RoutingOptionsMap {
 *     here: import('./here.types').HereRoutingOptions;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RoutingOptionsMap {
  // Declared empty; each provider's config module adds its own key.
}

/**
 * Resolves the per-provider Routing input type. Falls back to {@link IRoutingOptions}
 * when the provider hasn't augmented {@link RoutingOptionsMap} — so
 * `RoutingOptionsFor<'google'>` is `IRoutingOptions`, while
 * `RoutingOptionsFor<'here'>` also carries `transportMode`. Adding a key to the map
 * narrows that provider's `.route` call site automatically.
 */
export type RoutingOptionsFor<P extends string> = P extends keyof RoutingOptionsMap
  ? RoutingOptionsMap[P]
  : IRoutingOptions;
