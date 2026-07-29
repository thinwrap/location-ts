import type { LatLng } from './coordinate.type';
import type { Passthrough } from './passthrough.type';

/**
 * Geocoding (forward) input options.
 *
 * A consumer can geocode an address via
 * `new Geocoding(providerId, cfg).geocode(input)`.
 *
 * Per-provider augmentation: providers may extend this via
 * {@link GeocodeOptionsMap} (TS module augmentation). None currently do.
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
 * Reverse-geocoding input options.
 *
 * reverse-geocode returns the same `candidates[]` shape as
 * forward-geocode; consumers picking the "best" candidate should read
 * `result.candidates[0]`.
 */
export interface IReverseGeocodeOptions {
  location: LatLng;
  language?: string;
  _passthrough?: Passthrough;
}

/**
 * Autocomplete (prediction) input options.
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
  /**
   * Hard country filter, ISO 3166-1 alpha-2 (e.g. `['IL', 'PS']`) — the same
   * vocabulary as {@link IGeocodeOptions.countryFilter}.
   *
   * All five geocoders support one natively, so this is a base field rather than
   * a `_passthrough` concern. Each connector translates it into that vendor's
   * own parameter:
   *
   * | Provider | Parameter | Translation |
   * |---|---|---|
   * | Google | `includedRegionCodes` | lowercased ccTLD, **max 15 codes** |
   * | Mapbox | `country` | lowercased CSV |
   * | TomTom | `countrySet` | CSV, verbatim |
   * | Esri | `countryCode` | CSV, verbatim |
   * | HERE | `in=countryCode:` | alpha-2 → **alpha-3** |
   *
   * Two provider behaviours are worth knowing before you rely on this:
   *
   * - **Google** takes ccTLD codes, not ISO. The two disagree on the United
   *   Kingdom (`GB` → `uk`), which the connector translates. Setting this
   *   parameter also makes Google stop returning *query* predictions, so it
   *   changes which kinds of suggestion come back, not just how many.
   * - **HERE** requires a country filter to be accompanied by a location
   *   (`at`/`in=circle`), so pass `location` alongside it.
   */
  countryFilter?: string[];
  _passthrough?: Passthrough;
}

/**
 * A single normalized geocoding candidate.
 *
 * `viewport` is promoted to the base output type — all 5
 * geocoding providers natively return viewports, so no escape hatch is
 * needed.
 */
export interface IGeocodeCandidate {
  formattedAddress: string;
  location: LatLng;
  placeId?: string;
  /**
   * Bounding box (southwest + northeast corners), on the base shape because all
   * five geocoding providers return one natively. Populated when the provider
   * supplied it.
   */
  viewport?: { southwest: LatLng; northeast: LatLng };
}

/**
 * Normalized geocoding (forward) result.
 *
 * `candidates` is the list of ranked candidates the vendor returned;
 * `candidates[0]` is the highest-confidence pick.
 *
 * `raw` exposes the vendor's raw response body for consumer-side power-use;
 * typed as `unknown` to force consumer-side narrowing.
 */
export interface IGeocodeResult {
  candidates: IGeocodeCandidate[];
  raw: unknown;
}

/**
 * Normalized reverse-geocoding result.
 *
 * The result shape **mirrors forward-geocode** (`candidates[]`) rather
 * than returning a single result. 4/5 providers (Google, Mapbox, HERE,
 * TomTom) return ranked features natively; ESRI returns a single result
 * which the per-connector wraps into a one-element array.
 */
export interface IReverseGeocodeResult {
  candidates: IGeocodeCandidate[];
  raw: unknown;
}

/**
 * A single autocomplete prediction.
 */
export interface IAutocompletePrediction {
  description: string;
  placeId?: string;

  /**
   * The prediction split into its primary and secondary parts, when the provider
   * returns them as distinct fields.
   *
   * This is what lets a UI render the usual two-line suggestion — the place name
   * in bold above a greyed-out address — without guessing where to split
   * `description`. Splitting on the first comma is the workaround this replaces,
   * and it breaks on names that contain commas and on locales that order the
   * address differently.
   *
   * **Never synthesized.** The object is present only when the provider supplies a
   * genuinely distinct main part:
   *
   * | Provider | Source | Notes |
   * |---|---|---|
   * | Google | `structuredFormat.mainText.text` / `.secondaryText.text` | default-on, no extra cost |
   * | Mapbox | `name` / `place_formatted` | Search Box suggest |
   * | HERE | `title` / `address.label` | `secondaryText` absent for *query*-type suggestions, which carry no address |
   * | TomTom | `poi.name` / `address.freeformAddress` | **absent for street/address results** — they have no `poi.name`, and splitting the formatted address would be a guess |
   * | Esri | — | returns a single flat `text` field; the genuine gap |
   *
   * So an absent `structuredFormat` means "this provider/row has no distinct main
   * part", and `description` remains the thing to render.
   */
  structuredFormat?: IAutocompleteStructuredFormat;
}

/**
 * The two display parts of an autocomplete prediction.
 *
 * `secondaryText` is optional because HERE's query-type suggestions have a title
 * but no address at all — emitting an empty string there would be a fabricated
 * value a UI would happily render as a blank second line.
 */
export interface IAutocompleteStructuredFormat {
  mainText: string;
  secondaryText?: string;
}

/**
 * Normalized autocomplete result.
 */
export interface IAutocompleteResult {
  predictions: IAutocompletePrediction[];
  raw: unknown;
}

/**
 * Input for a place-details lookup: resolve a `placeId` from an autocomplete
 * prediction into a full candidate.
 *
 * This is deliberately ONE operation rather than two. "Place details" and
 * "geocode by place id" are the same vendor call — every provider resolves its
 * own opaque id to the same address+coordinates payload — so splitting them
 * would put two names on one request.
 *
 * The `placeId` must come from the SAME provider's `autocomplete()`: these ids
 * are provider-scoped and are not interchangeable.
 */
export interface IPlaceDetailsOptions {
  placeId: string;
  language?: string;

  /**
   * Optional output fields to fetch. Defaults to `[]`.
   *
   * Same opt-in discipline as routing's `include`, and for the same reason: on
   * Google the Place Details **field mask selects the SKU tier**, so requesting
   * `name` (`displayName`) moves the call to Pro. Providers that return the name
   * for free ignore the token's cost implication but still honour it as a gate,
   * so the normalized shape stays identical everywhere.
   */
  include?: PlaceDetailsInclude[];

  _passthrough?: Passthrough;
}

/**
 * Normalized place-details result.
 *
 * Returns a full {@link IGeocodeCandidate} rather than a new shape, because that
 * is what the operation resolves to and reusing it means a consumer can feed the
 * result straight into whatever already consumes geocode candidates.
 */
export interface IPlaceDetailsResult {
  candidate: IGeocodeCandidate;

  /**
   * The place's display name, when the provider returns one distinct from the
   * formatted address (e.g. "Blue Bottle Coffee" vs its street address).
   *
   * Absent on providers that only return an address, and on Google unless
   * `include: ['name']` was requested — its Place Details SKU tier is driven by
   * the field mask, and `displayName` is a Pro-tier field. Note that this is the
   * opposite of Compute Routes, whose SKU is feature-driven: check per API.
   */
  name?: string;

  raw: unknown;
}

/**
 * Opt-in tokens for optional place-details output fields, mirroring
 * `RoutingInclude`.
 */
export type PlaceDetailsInclude = 'name';

/**
 * Internal connector contract implemented by every per-provider Geocoding
 * connector class (e.g. `GoogleGeocodingConnector`).
 *
 * `providerId` is intentionally typed as `string` rather than
 * `GeocodingProvider` so that bring-your-own-connector consumers can pass a
 * custom provider id. Per-connector classes narrow it via
 * `readonly providerId = 'google';`.
 */
export interface IGeocodingConnector {
  readonly providerId: string;

  /**
   * Resolve a provider `placeId` to a full candidate.
   *
   * **Optional on purpose.** Making it required would break every existing
   * implementer of this interface — a major-version change — for an operation
   * only some providers support. All five geocoding providers implement it today,
   * so the optionality exists purely to keep bring-your-own-connector consumers
   * compiling.
   *
   * Prefer the `Geocoding` facade, whose `PlaceDetailsProvider` union rejects an
   * unsupported provider at compile time instead.
   */
  placeDetails?(options: IPlaceDetailsOptions): Promise<IPlaceDetailsResult>;
  geocode(options: IGeocodeOptions): Promise<IGeocodeResult>;
  reverseGeocode(options: IReverseGeocodeOptions): Promise<IReverseGeocodeResult>;
  autocomplete(options: IAutocompleteOptions): Promise<IAutocompleteResult>;
}

/**
 * Provider-specific forward-geocode input augmentations. Keyed by provider id;
 * providers that add nothing are absent and fall back to {@link IGeocodeOptions}
 * via {@link GeocodeOptionsFor}.
 *
 * Augmentations are declared in `src/providers/<id>/<id>.config.ts`, **not** in
 * `<id>.types.ts` — see {@link AutocompleteOptionsMap} for why that distinction
 * decides whether a consumer can see them at all.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GeocodeOptionsMap {
  // No provider augments forward-geocode; each would add its own key here.
}

/**
 * Provider-specific reverse-geocode input augmentations.
 *
 * @see GeocodeOptionsMap
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReverseGeocodeOptionsMap {
  // No provider augments reverse-geocode.
}

/**
 * Provider-specific autocomplete input augmentations. Google adds `sessionToken`
 * here, which is what makes its keystrokes bill as one session.
 *
 * The declaration must live in the provider's `<id>.config.ts`. A `declare module`
 * block only applies when the file declaring it is part of the consumer's
 * compilation: config types are re-exported from the package entry, so those files
 * are reachable, while `<id>.types.ts` is imported by nothing in the emitted type
 * graph. Declared there, an augmentation resolves inside this repo and is silently
 * missing from the published package — which is how Mapbox's `sessionToken` shipped
 * unusable. `check:dist` gates it by typechecking a real consumer against `dist/`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AutocompleteOptionsMap {
  // Google adds its key from `google.config.ts`.
}

/**
 * Provider-specific place-details input augmentations. Google and Mapbox both add
 * `sessionToken` here — the value that closes the autocomplete session they billed.
 *
 * @see AutocompleteOptionsMap
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PlaceDetailsOptionsMap {
  // Google and Mapbox add their keys from their `*.config.ts` modules.
}

/**
 * Resolves the per-provider place-details input type. Falls back to
 * {@link IPlaceDetailsOptions} when the provider hasn't augmented
 * {@link PlaceDetailsOptionsMap}.
 */
export type PlaceDetailsOptionsFor<P extends string> =
  P extends keyof PlaceDetailsOptionsMap
    ? PlaceDetailsOptionsMap[P]
    : IPlaceDetailsOptions;

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
