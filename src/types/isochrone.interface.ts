import type { Polygon } from 'geojson';
import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Isochrone input options. **LOCKED AT v1.0.**
 *
 * A consumer can compute an isochrone via
 * `new Isochrone(providerId, cfg).isochrone(input)`.
 *
 * Honesty corrections applied at v1.0:
 *
 * `departureTime` is promoted to the base shape because all 4
 *   Isochrone providers (Mapbox, HERE, ESRI, TomTom) support a
 *   departure-time-conditioned isochrone natively.
 * base `travelMode` is narrowed to `'driving' | 'walking'`
 *   only — `'cycling'` is **demoted to provider-narrowed** because only 2/4
 *   providers (Mapbox, TomTom) have native bicycle support. The Mapbox and
 *   TomTom per-connector files augment {@link IsochroneOptionsMap} to add
 *   `'cycling'` back for those two providers.
 *
 * The 4-value cap (Mapbox's native ceiling) is enforced at runtime
 * via `validateIsochroneCap` rather than in the type — TS cannot express
 * "array of at most 4 items" cleanly, and lifting the cap to the type would
 * defeat the purpose of letting callers provide a dynamic `values` array.
 *
 * Per-provider augmentation: providers may extend this via
 * {@link IsochroneOptionsMap} (TS module augmentation).
 *
 * Changing any field shape post-v1.0 requires a major version bump.
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
 * A single isochrone contour — one polygon per requested break. **LOCKED AT v1.0.**
 *
 * `value` matches the corresponding `IIsochroneOptions.values[i]` in the same
 * unit (seconds for `'time'`, meters for `'distance'`).
 *
 * `geometry` is a standard GeoJSON Polygon (`{ type: 'Polygon', coordinates:
 * number[][][] }`) with a closed outer ring (first and last coordinate equal).
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IIsochroneContour {
  value: number;
  geometry: Polygon;
}

/**
 * Normalized Isochrone result. **LOCKED AT v1.0.**
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
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IIsochroneResult {
  contours: IIsochroneContour[];
  raw: unknown;
  _meta?: { requestCount: number };
}

/**
 * Internal connector contract implemented by every per-provider Isochrone
 * connector class (e.g. `MapboxIsochroneConnector`). **LOCKED AT v1.0.**
 *
 * `providerId` is intentionally typed as `string` rather than
 * `IsochroneProvider` so that bring-your-own-connector consumers can pass a
 * custom provider id. Per-connector classes narrow it via
 * `readonly providerId = 'mapbox';`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IIsochroneConnector {
  readonly providerId: string;
  isochrone(options: IIsochroneOptions): Promise<IIsochroneResult>;
}

/**
 * Provider-specific Isochrone input augmentations.
 *
 * Each per-connector file may augment this interface via TS
 * module augmentation in its `src/providers/<id>/<id>.types.ts` file.
 * Providers that don't augment fall back to {@link IIsochroneOptions} via
 * {@link IsochroneOptionsFor}.
 *
 * Mapbox and TomTom augment this map
 * to widen `travelMode` to include `'cycling'`. HERE and ESRI do NOT
 * augment; their narrowed type stays at base `'driving' | 'walking'`.
 *
 * @example Mapbox augments to re-add cycling:
 * ```ts
 * // src/providers/mapbox/mapbox.types.ts
 * declare module '../../types/isochrone.interface' {
 *   interface IsochroneOptionsMap {
 *     mapbox: Omit<IIsochroneOptions, 'travelMode'> & {
 *       travelMode?: 'driving' | 'walking' | 'cycling';
 *     };
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IsochroneOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Resolves the per-provider Isochrone input type. Falls back to
 * {@link IIsochroneOptions} when the provider hasn't augmented
 * {@link IsochroneOptionsMap}.
 *
 * At v1.0 with no per-provider augmentations, `IsochroneOptionsFor<P>` for
 * HERE/ESRI resolves to `IIsochroneOptions`. Mapbox/TomTom augment to widen
 * `travelMode`.
 */
export type IsochroneOptionsFor<P extends string> = P extends keyof IsochroneOptionsMap
  ? IsochroneOptionsMap[P]
  : IIsochroneOptions;
