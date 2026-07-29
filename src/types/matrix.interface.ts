import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';
import type { TrafficMode } from './routing.interface';

/**
 * Matrix input options.
 *
 * A consumer can compute a distance/duration matrix via
 * `new Matrix(providerId, cfg).matrix(input)`.
 *
 * Per-provider augmentation: providers extend this via {@link MatrixOptionsMap}
 * (TS module augmentation) — HERE adds `transportMode` for its extra vehicle
 * classes.
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

  /**
   * Whether to compute cells against live traffic. Defaults to `'none'`.
   *
   * Opt-in for the same reason as on routing — and the stakes are higher here.
   * Google's Route Matrix bills **per element**, so a traffic-aware 10x10 request
   * moves 100 billed elements onto the Pro-tier SKU, not one. Passing
   * `departureTime` alone therefore does NOT enable traffic; ask for it.
   */
  trafficMode?: TrafficMode;

  _passthrough?: Passthrough;
}

/**
 * A single cell of a Matrix response — the leg from one origin to one
 * destination.
 *
 * The result is a flat `cells[]` shape (vs. a 2D matrix); every
 * per-connector flattens the vendor's 2D response. Missing/failed entries
 * are omitted from `cells[]` (the consumer can still inspect `result.raw`
 * for power-use).
 *
 * Distances normalized to meters; durations normalized to seconds
 * *
 */
export interface IMatrixCell {
  originIndex: number;
  destinationIndex: number;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Normalized Matrix result.
 *
 * `cells` is the flat list of origin/destination pairs the vendor returned
 * Missing/failed entries are omitted; consumers needing the full
 * 2D shape can re-pivot via `originIndex`/`destinationIndex`.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 */
export interface IMatrixResult {
  cells: IMatrixCell[];
  raw: unknown;
}

/**
 * Internal connector contract implemented by every per-provider Matrix
 * connector class (e.g. `GoogleMatrixConnector`).
 *
 * `providerId` is intentionally typed as `string` rather than `MatrixProvider`
 * so that bring-your-own-connector consumers can pass a custom provider id.
 * Per-connector classes narrow it via `readonly providerId = 'google';`.
 */
export interface IMatrixConnector {
  readonly providerId: string;
  matrix(options: IMatrixOptions): Promise<IMatrixResult>;
}

/**
 * Provider-specific Matrix input augmentations.
 *
 * HERE adds `transportMode` for its extra vehicle classes. Providers that add
 * nothing are absent and fall back to {@link IMatrixOptions} via
 * {@link MatrixOptionsFor}.
 *
 * HERE declares this one inside `here.matrix.connector.ts`, which works because the
 * connector class is exported from the package entry — the requirement is only that
 * the declaring file be reachable. Everywhere else the augmentation sits in
 * `<id>.config.ts`; see {@link AutocompleteOptionsMap} in `geocoding.interface.ts`
 * for what goes wrong when it is not reachable.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MatrixOptionsMap {
  // HERE adds its key from `here.matrix.connector.ts`.
}

/**
 * Resolves the per-provider Matrix input type. Falls back to {@link IMatrixOptions}
 * when the provider hasn't augmented {@link MatrixOptionsMap}.
 *
 * So `MatrixOptionsFor<'google'>` is `IMatrixOptions`, while
 * `MatrixOptionsFor<'here'>` also carries `transportMode`. Adding a key to the map
 * narrows that provider's `.matrix` call site automatically.
 */
export type MatrixOptionsFor<P extends string> = P extends keyof MatrixOptionsMap
  ? MatrixOptionsMap[P]
  : IMatrixOptions;
