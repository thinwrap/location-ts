import type { Polygon } from 'geojson';
import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Isochrone input options.
 *
 * A consumer can compute an isochrone via
 * `new Isochrone(providerId, cfg).isochrone(input)`.
 *
 * Two shape decisions follow from the ≥90% baseline rule:
 *
 * - `departureTime` is on the base shape because all four isochrone providers
 *   (Mapbox, HERE, ESRI, TomTom) condition on a departure time natively.
 * - `travelMode` is only `'driving' | 'walking'`, because just two of the four
 *   (Mapbox, TomTom) have native bicycle support. Those two widen it back to
 *   include `'cycling'` via {@link IsochroneOptionsMap}.
 *
 * The 4-value cap (Mapbox's native ceiling) is enforced at runtime via
 * `validateIsochroneCap` rather than in the type: TS cannot express "array of at
 * most 4 items" without forcing callers to build a tuple, which defeats passing a
 * dynamic `values` array.
 *
 * Per-provider augmentation: providers may extend this via
 * {@link IsochroneOptionsMap} (TS module augmentation).
 *
 * @see IsochroneOptionsMap
 * @see IsochroneOptionsFor
 */
export interface IIsochroneOptions {
  center: LatLng;
  /** `'time'` → values are seconds; `'distance'` → values are meters. */
  type: 'time' | 'distance';
  /**
   * One break per contour. Seconds for `type: 'time'`, meters for
   * `type: 'distance'`. **At most 4 values** (Mapbox's native
   * ceiling); enforced at runtime via the shared `validateIsochroneCap`
   * helper called at the top of every per-connector `.isochrone`.
   */
  values: number[];
  /**
   * Base mode set (only `'driving'` and `'walking'` are baseline
   * across all 4 providers). Mapbox and TomTom augment
   * {@link IsochroneOptionsMap} to add `'cycling'`.
   */
  travelMode?: 'driving' | 'walking';
  /**
   * ISO 8601 timestamp for time-of-day-conditioned isochrones.
   * Supported by all 4 Isochrone providers.
   */
  departureTime?: string;
  _passthrough?: Passthrough;
}

/**
 * A single isochrone contour — one polygon per requested break.
 *
 * `value` matches the corresponding `IIsochroneOptions.values[i]` in the same
 * unit (seconds for `'time'`, meters for `'distance'`).
 *
 * `geometry` is a standard GeoJSON Polygon (`{ type: 'Polygon', coordinates:
 * number[][][] }`) with a closed outer ring (first and last coordinate equal).
 */
export interface IIsochroneContour {
  value: number;
  geometry: Polygon;
}

/**
 * Normalized Isochrone result.
 *
 * `contours` is sorted by `value` ascending so callers can rely on
 * `contours[0]` being the smallest break.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 *
 * `_meta` is **present iff N>1** — i.e. only when the connector issued more
 * than one underlying HTTP call to satisfy a multi-value request (TomTom,
 * which supports only one budget per call and so issues one request
 * per value). When `_meta` is present, `_meta.requestCount` is that call count
 * (>1). Any path fulfilled in a single HTTP call omits the `_meta` key
 * entirely (cross-language convergence with the PHP sibling).
 */
export interface IIsochroneResult {
  contours: IIsochroneContour[];
  raw: unknown;
  _meta?: { requestCount: number };
}

/**
 * Internal connector contract implemented by every per-provider Isochrone
 * connector class (e.g. `MapboxIsochroneConnector`).
 *
 * `providerId` is intentionally typed as `string` rather than
 * `IsochroneProvider` so that bring-your-own-connector consumers can pass a
 * custom provider id. Per-connector classes narrow it via
 * `readonly providerId = 'mapbox';`.
 */
export interface IIsochroneConnector {
  readonly providerId: string;
  isochrone(options: IIsochroneOptions): Promise<IIsochroneResult>;
}

/**
 * Provider-specific Isochrone input augmentations.
 *
 * Mapbox and TomTom widen `travelMode` to include `'cycling'`; HERE and ESRI stay
 * at the base `'driving' | 'walking'` and are absent from this map, falling back to
 * {@link IIsochroneOptions} via {@link IsochroneOptionsFor}.
 *
 * The declaration must live in the provider's `<id>.config.ts` — see
 * {@link AutocompleteOptionsMap} in `geocoding.interface.ts` for why declaring it in
 * `<id>.types.ts` makes it invisible to consumers.
 *
 * @example `src/providers/mapbox/mapbox.config.ts`:
 * ```ts
 * declare module '../../types/isochrone.interface' {
 *   interface IsochroneOptionsMap {
 *     mapbox: Omit<import('../../types').IIsochroneOptions, 'travelMode'> & {
 *       travelMode?: 'driving' | 'walking' | 'cycling';
 *     };
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IsochroneOptionsMap {
  // Mapbox and TomTom add their keys from their `*.config.ts` modules.
}

/**
 * Resolves the per-provider Isochrone input type. Falls back to
 * {@link IIsochroneOptions} when the provider hasn't augmented
 * {@link IsochroneOptionsMap}.
 *
 * So `IsochroneOptionsFor<'here'>` is `IIsochroneOptions`, while
 * `IsochroneOptionsFor<'mapbox'>` also accepts `travelMode: 'cycling'`.
 */
export type IsochroneOptionsFor<P extends string> = P extends keyof IsochroneOptionsMap
  ? IsochroneOptionsMap[P]
  : IIsochroneOptions;
