import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Routing input options. **LOCKED AT v1.0.**
 *
 * A consumer can compute a route via
 * `new Routing(providerId, cfg).route(input)`.
 *
 * Per-provider augmentation: providers may extend this via {@link RoutingOptionsMap}
 * (TS module augmentation). For example, HERE may add `transportMode: 'truck'`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
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
  _passthrough?: Passthrough;
}

/**
 * A single leg of a Routing response (from one waypoint to the next). **LOCKED AT v1.0.**
 *
 * Distances normalized to meters; durations normalized to seconds.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IRoutingLeg {
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Normalized Routing result. **LOCKED AT v1.0.**
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
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IRoutingResult {
  legs: IRoutingLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  polyline: string;
  waypointOrder?: number[];
  raw: unknown;
}

/**
 * Internal connector contract implemented by every per-provider Routing
 * connector class (e.g. `GoogleRoutingConnector`). **LOCKED AT v1.0.**
 *
 * `providerId` is intentionally typed as `string` rather than `RoutingProvider`
 * so that bring-your-own-connector consumers can pass a custom provider id.
 * Per-connector classes narrow it via `readonly providerId = 'google';`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IRoutingConnector {
  readonly providerId: string;
  route(options: IRoutingOptions): Promise<IRoutingResult>;
}

/**
 * Provider-specific Routing input augmentations.
 *
 * Each per-connector file augments this interface via TS module
 * augmentation in its `src/providers/<id>/<id>.types.ts` file. Providers that
 * don't augment fall back to {@link IRoutingOptions} via {@link RoutingOptionsFor}.
 *
 * At v1.0 this base map is intentionally empty; per-connector stories layer
 * their own keys onto it.
 *
 * @example HERE augments with vehicle-class transport modes:
 * ```ts
 * // src/providers/here/here.types.ts
 * import type { IRoutingOptions } from '../../types';
 * export interface HereRoutingOptions extends IRoutingOptions {
 *   transportMode?: 'car' | 'truck' | 'pedestrian' | 'bicycle' | 'scooter';
 * }
 * declare module '../../types/routing.interface' {
 *   interface RoutingOptionsMap {
 *     here: HereRoutingOptions;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RoutingOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Resolves the per-provider Routing input type. Falls back to {@link IRoutingOptions}
 * when the provider hasn't augmented {@link RoutingOptionsMap}.
 *
 * At v1.0 with no per-provider augmentations, `RoutingOptionsFor<'google'>` etc.
 * all resolve to `IRoutingOptions`. Once a per-connector story augments
 * `RoutingOptionsMap` with its own key, that provider's `.route` call site
 * narrows automatically.
 */
export type RoutingOptionsFor<P extends string> = P extends keyof RoutingOptionsMap
  ? RoutingOptionsMap[P]
  : IRoutingOptions;
