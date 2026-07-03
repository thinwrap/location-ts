import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Matrix input options. **LOCKED AT v1.0.**
 *
 * A consumer can compute a distance/duration matrix via
 * `new Matrix(providerId, cfg).matrix(input)`.
 *
 * Per-provider augmentation: providers may extend this via {@link MatrixOptionsMap}
 * (TS module augmentation). For example, HERE may add `transportMode: 'truck'`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 *
 * @see MatrixOptionsMap
 * @see MatrixOptionsFor
 */
export interface IMatrixOptions {
  origins: LatLng[];
  destinations: LatLng[];
  travelMode?: 'driving' | 'walking' | 'cycling';
  avoidTolls?: boolean;
  departureTime?: Date;
  _passthrough?: Passthrough;
}

/**
 * A single cell of a Matrix response — the leg from one origin to one
 * destination. **LOCKED AT v1.0.**
 *
 * The result is a flat `cells[]` shape (vs. a 2D matrix); every
 * per-connector flattens the vendor's 2D response. Missing/failed entries
 * are omitted from `cells[]` (the consumer can still inspect `result.raw`
 * for power-use).
 *
 * Distances normalized to meters; durations normalized to seconds
 * *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IMatrixCell {
  originIndex: number;
  destinationIndex: number;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Normalized Matrix result. **LOCKED AT v1.0.**
 *
 * `cells` is the flat list of origin/destination pairs the vendor returned
 * Missing/failed entries are omitted; consumers needing the full
 * 2D shape can re-pivot via `originIndex`/`destinationIndex`.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IMatrixResult {
  cells: IMatrixCell[];
  raw: unknown;
}

/**
 * Internal connector contract implemented by every per-provider Matrix
 * connector class (e.g. `GoogleMatrixConnector`). **LOCKED AT v1.0.**
 *
 * `providerId` is intentionally typed as `string` rather than `MatrixProvider`
 * so that bring-your-own-connector consumers can pass a custom provider id.
 * Per-connector classes narrow it via `readonly providerId = 'google';`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IMatrixConnector {
  readonly providerId: string;
  matrix(options: IMatrixOptions): Promise<IMatrixResult>;
}

/**
 * Provider-specific Matrix input augmentations.
 *
 * Each per-connector file augments this interface via TS module
 * augmentation in its `src/providers/<id>/<id>.types.ts` file. Providers that
 * don't augment fall back to {@link IMatrixOptions} via {@link MatrixOptionsFor}.
 *
 * At v1.0 this base map is intentionally empty; per-connector stories layer
 * their own keys onto it.
 *
 * @example HERE augments with vehicle-class transport modes:
 * ```ts
 * // src/providers/here/here.types.ts
 * import type { IMatrixOptions } from '../../types';
 * export interface HereMatrixOptions extends IMatrixOptions {
 *   transportMode?: 'car' | 'truck' | 'pedestrian' | 'bicycle' | 'scooter';
 * }
 * declare module '../../types/matrix.interface' {
 *   interface MatrixOptionsMap {
 *     here: HereMatrixOptions;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MatrixOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Resolves the per-provider Matrix input type. Falls back to {@link IMatrixOptions}
 * when the provider hasn't augmented {@link MatrixOptionsMap}.
 *
 * At v1.0 with no per-provider augmentations, `MatrixOptionsFor<'google'>` etc.
 * all resolve to `IMatrixOptions`. Once a per-connector story augments
 * `MatrixOptionsMap` with its own key, that provider's `.matrix` call site
 * narrows automatically.
 */
export type MatrixOptionsFor<P extends string> = P extends keyof MatrixOptionsMap
  ? MatrixOptionsMap[P]
  : IMatrixOptions;
