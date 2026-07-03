import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Geocoding (forward) input options. **LOCKED AT v1.0.**
 *
 * A consumer can geocode an address via
 * `new Geocoding(providerId, cfg).geocode(input)`.
 *
 * Per-provider augmentation: providers may extend this via
 * {@link GeocodeOptionsMap} (TS module augmentation). For example, Google may
 * add a legacy `region` alias for `countryFilter`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 *
 * @see GeocodeOptionsMap
 * @see GeocodeOptionsFor
 */
export interface IGeocodeOptions {
  address: string;
  language?: string;
  /**
   * Hard country filter (rename from legacy `region`).
   * ISO 3166-1 alpha-2 codes (e.g. `['US', 'CA']`).
   */
  countryFilter?: string[];
  _passthrough?: Passthrough;
}

/**
 * Reverse-geocoding input options. **LOCKED AT v1.0.**
 *
 * reverse-geocode returns the same `candidates[]` shape as
 * forward-geocode; consumers picking the "best" candidate should read
 * `result.candidates[0]`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IReverseGeocodeOptions {
  location: LatLng;
  language?: string;
  _passthrough?: Passthrough;
}

/**
 * Autocomplete (prediction) input options. **LOCKED AT v1.0.**
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IAutocompleteOptions {
  input: string;
  location?: LatLng;
  /**
   * Bias radius in meters around {@link location}.
   *
   * Caveat: Mapbox and ESRI ignore `radius` — they accept only a proximity
   * point (`location`) with no radius parameter, so this value is silently
   * dropped for those two providers.
   */
  radius?: number;
  language?: string;
  _passthrough?: Passthrough;
}

/**
 * A single normalized geocoding candidate. **LOCKED AT v1.0.**
 *
 * `viewport` is promoted to the base output type — all 5
 * geocoding providers natively return viewports, so no escape hatch is
 * needed.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IGeocodeCandidate {
  formattedAddress: string;
  location: LatLng;
  placeId?: string;
  /**
   * bounding box (southwest + northeast corners) promoted to
   * the base shape; populated when the provider returns one.
   */
  viewport?: { southwest: LatLng; northeast: LatLng };
}

/**
 * Normalized geocoding (forward) result. **LOCKED AT v1.0.**
 *
 * `candidates` is the list of ranked candidates the vendor returned;
 * `candidates[0]` is the highest-confidence pick.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IGeocodeResult {
  candidates: IGeocodeCandidate[];
  raw: unknown;
}

/**
 * Normalized reverse-geocoding result. **LOCKED AT v1.0.**
 *
 * The result shape **mirrors forward-geocode** (`candidates[]`) rather
 * than returning a single result. 4/5 providers (Google, Mapbox, HERE,
 * TomTom) return ranked features natively; ESRI returns a single result
 * which the per-connector wraps into a one-element array.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IReverseGeocodeResult {
  candidates: IGeocodeCandidate[];
  raw: unknown;
}

/**
 * A single autocomplete prediction. **LOCKED AT v1.0.**
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IAutocompletePrediction {
  description: string;
  placeId?: string;
}

/**
 * Normalized autocomplete result. **LOCKED AT v1.0.**
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IAutocompleteResult {
  predictions: IAutocompletePrediction[];
  raw: unknown;
}

/**
 * Internal connector contract implemented by every per-provider Geocoding
 * connector class (e.g. `GoogleGeocodingConnector`). **LOCKED AT v1.0.**
 *
 * `providerId` is intentionally typed as `string` rather than
 * `GeocodingProvider` so that bring-your-own-connector consumers can pass a
 * custom provider id. Per-connector classes narrow it via
 * `readonly providerId = 'google';`.
 *
 * Changing any field shape post-v1.0 requires a major version bump.
 */
export interface IGeocodingConnector {
  readonly providerId: string;
  geocode(options: IGeocodeOptions): Promise<IGeocodeResult>;
  reverseGeocode(options: IReverseGeocodeOptions): Promise<IReverseGeocodeResult>;
  autocomplete(options: IAutocompleteOptions): Promise<IAutocompleteResult>;
}

/**
 * Provider-specific forward-geocode input augmentations.
 *
 * Each per-connector file may augment this interface via TS
 * module augmentation in its `src/providers/<id>/<id>.types.ts` file.
 * Providers that don't augment fall back to {@link IGeocodeOptions} via
 * {@link GeocodeOptionsFor}.
 *
 * At v1.0 this base map is intentionally empty; per-connector stories layer
 * their own keys onto it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GeocodeOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Provider-specific reverse-geocode input augmentations.
 *
 * @see GeocodeOptionsMap for the augmentation mechanism rationale.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReverseGeocodeOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Provider-specific autocomplete input augmentations.
 *
 * @see GeocodeOptionsMap for the augmentation mechanism rationale.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AutocompleteOptionsMap {
  // Augmented per-provider via TS module augmentation. Empty here at v1.0.
}

/**
 * Resolves the per-provider forward-geocode input type. Falls back to
 * {@link IGeocodeOptions} when the provider hasn't augmented
 * {@link GeocodeOptionsMap}.
 */
export type GeocodeOptionsFor<P extends string> = P extends keyof GeocodeOptionsMap
  ? GeocodeOptionsMap[P]
  : IGeocodeOptions;

/**
 * Resolves the per-provider reverse-geocode input type. Falls back to
 * {@link IReverseGeocodeOptions} when the provider hasn't augmented
 * {@link ReverseGeocodeOptionsMap}.
 */
export type ReverseGeocodeOptionsFor<P extends string> =
  P extends keyof ReverseGeocodeOptionsMap
    ? ReverseGeocodeOptionsMap[P]
    : IReverseGeocodeOptions;

/**
 * Resolves the per-provider autocomplete input type. Falls back to
 * {@link IAutocompleteOptions} when the provider hasn't augmented
 * {@link AutocompleteOptionsMap}.
 */
export type AutocompleteOptionsFor<P extends string> =
  P extends keyof AutocompleteOptionsMap
    ? AutocompleteOptionsMap[P]
    : IAutocompleteOptions;
