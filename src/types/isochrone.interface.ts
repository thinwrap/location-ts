import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * A GeoJSON Polygon (RFC 7946 §3.1.6): `coordinates` is an array of linear
 * rings — the outer ring first, then any holes — each a closed list of
 * `[lng, lat]` positions.
 *
 * Declared here rather than imported from `@types/geojson`: that package is
 * only a devDependency, so a published `.d.ts` importing from `'geojson'`
 * breaks a consumer that does not happen to install it (TS2307, or `geometry`
 * silently widened to `any`), and the package ships zero dependencies. The
 * shape is structurally assignable to `@types/geojson`'s `Polygon`, so a
 * consumer who does use that package can pass a contour's geometry straight in.
 */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

/**
 * A GeoJSON MultiPolygon (RFC 7946 §3.1.7): `coordinates` is an array of
 * {@link GeoJsonPolygon} coordinate arrays — one `[exterior, ...holes]` entry
 * per disconnected part.
 *
 * An isochrone contour takes this shape only when the provider returns more
 * than one disconnected area for a single break (an island reached by ferry, a
 * region cut by water); HERE and ESRI both document multi-part results. Declared
 * locally for the same zero-dependency reason as {@link GeoJsonPolygon}, and
 * likewise assignable to `@types/geojson`'s `MultiPolygon`.
 */
export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

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
 * - `travelMode` is only `'driving' | 'walking'`; Mapbox and TomTom widen it to
 *   include `'cycling'` via {@link IsochroneOptionsMap}. TomTom's
 *   calculateReachableRange forbids its `pedestrian` and `bicycle` modes, so the
 *   TomTom connector rejects `'walking'` and `'cycling'` with
 *   `unsupported_travel_mode` before any request.
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
  /**
   * `'time'` → values are seconds; `'distance'` → values are meters. Required:
   * a missing or unknown value rejects with a `TypeError`.
   */
  type: 'time' | 'distance';
  /**
   * One break per contour. Seconds for `type: 'time'`, meters for
   * `type: 'distance'`. **At most 4 values** (Mapbox's native
   * ceiling); enforced at runtime via the shared `validateIsochroneCap`
   * helper called at the top of every per-connector `.isochrone`.
   */
  values: number[];
  /**
   * Base mode set. Mapbox and TomTom augment {@link IsochroneOptionsMap} to add
   * `'cycling'`. TomTom rejects `'walking'` and `'cycling'` at runtime
   * (`unsupported_travel_mode`): its Reachable Range API forbids both modes.
   * HERE and ESRI reject `'cycling'` the same way. A value outside
   * `'driving' | 'walking' | 'cycling'` rejects with a `TypeError`.
   */
  travelMode?: 'driving' | 'walking';
  /**
   * ISO 8601 timestamp for time-of-day-conditioned isochrones.
   * Supported by all 4 Isochrone providers. A string that does not parse
   * rejects with `ConnectorError` `invalid_request`; a non-string value rejects
   * with a `TypeError`.
   *
   * Isochrones have no `trafficMode`: a departure time makes the contours
   * traffic-aware for that time on every provider (Esri, HERE, Mapbox, TomTom).
   * Without one, Esri and Mapbox `driving` use time-independent speeds and
   * TomTom its defaults (`traffic=true`, `departAt=now`); HERE's isoline docs
   * do not specify the omitted case.
   */
  departureTime?: string;
  _passthrough?: Passthrough;
}

/**
 * A single isochrone contour — one area per requested break.
 *
 * `value` matches the corresponding `IIsochroneOptions.values[i]` in the same
 * unit (seconds for `'time'`, meters for `'distance'`).
 *
 * `geometry` is a {@link GeoJsonPolygon} for a single connected area — the
 * common case — and a {@link GeoJsonMultiPolygon} holding every part when the
 * provider returns several disconnected areas for the break (HERE and ESRI
 * document multi-part results, a Mapbox `MultiPolygon` feature maps the same
 * way, and TomTom always returns a single boundary).
 * Read `geometry.type` before indexing `coordinates`: the nesting depth differs.
 *
 * Either way every polygon is `[exterior, ...holes]` in `[lng, lat]` order, the
 * provider's holes are kept, every ring is closed (first and last coordinate
 * equal), and rings are wound per RFC 7946 §3.1.6 — exterior counter-clockwise,
 * holes clockwise — whatever winding the provider used, so a GeoJSON consumer
 * that relies on the right-hand rule reads holes as holes.
 */
export interface IIsochroneContour {
  value: number;
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
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
 * entirely, so its presence alone says "more than one billable call".
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
