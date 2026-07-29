import type {
  IGeocodingConnector,
  IGeocodeOptions,
  IGeocodeResult,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  IAutocompleteOptions,
  IAutocompleteResult,
  GeocodeOptionsFor,
  ReverseGeocodeOptionsFor,
  AutocompleteOptionsFor,
  IPlaceDetailsOptions,
  IPlaceDetailsResult,
  PlaceDetailsOptionsFor,
  PlaceDetailsProvider,
  ProviderConfigMap,
  GeocodingProvider,
} from '../types';
import { ConnectorError } from '../types';
import { GoogleGeocodingConnector } from '../providers/google';
import { MapboxGeocodingConnector } from '../providers/mapbox';
import { HereGeocodingConnector } from '../providers/here';
import { EsriGeocodingConnector } from '../providers/esri';
import { TomTomGeocodingConnector } from '../providers/tomtom';

export class Geocoding<P extends GeocodingProvider> implements IGeocodingConnector {
  readonly providerId: P;
  private connector: IGeocodingConnector;

  constructor(provider: P, config: ProviderConfigMap[P], fetchImpl?: typeof fetch) {
    this.providerId = provider;
    this.connector = createGeocodingConnector(provider, config, fetchImpl);
  }

  // Per-provider input narrowing via `GeocodeOptionsMap` augmentation in
  // `src/providers/<id>/<id>.types.ts`. At v1.0 with no augmentations,
  // `GeocodeOptionsFor<P>` resolves to `IGeocodeOptions` for every provider.
  geocode(options: GeocodeOptionsFor<P>): Promise<IGeocodeResult> {
    return this.connector.geocode(options as IGeocodeOptions);
  }

  // Per-provider input narrowing via `ReverseGeocodeOptionsMap` augmentation.
  reverseGeocode(options: ReverseGeocodeOptionsFor<P>): Promise<IReverseGeocodeResult> {
    return this.connector.reverseGeocode(options as IReverseGeocodeOptions);
  }

  // Per-provider input narrowing via `AutocompleteOptionsMap` augmentation.
  autocomplete(options: AutocompleteOptionsFor<P>): Promise<IAutocompleteResult> {
    return this.connector.autocomplete(options as IAutocompleteOptions);
  }

  /**
   * Resolve a `placeId` from `autocomplete()` into a full candidate.
   *
   * The `P extends PlaceDetailsProvider` constraint is what makes this safe: a
   * provider outside that union fails to compile here, so the `placeDetails?`
   * optionality on the connector interface — which exists to keep 1.2.0 a minor
   * for bring-your-own-connector implementers — never becomes a runtime footgun
   * for facade users. The runtime guard below covers only a custom connector
   * injected past the type system.
   */
  // `async` so the guard below REJECTS rather than throwing synchronously: every
  // other facade method returns a promise, and a caller writing
  // `placeDetails(...).catch(...)` must not be bypassed by a sync throw.
  async placeDetails(
    this: Geocoding<P & PlaceDetailsProvider>,
    options: PlaceDetailsOptionsFor<P>,
  ): Promise<IPlaceDetailsResult> {
    const impl = this.connector.placeDetails?.bind(this.connector);
    if (impl === undefined) {
      throw new ConnectorError({
        message: `Provider '${this.providerId}' does not implement placeDetails`,
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage: `Provider '${this.providerId}' does not implement placeDetails`,
      });
    }
    return impl(options as IPlaceDetailsOptions);
  }
}

function createGeocodingConnector<P extends GeocodingProvider>(
  provider: P,
  config: ProviderConfigMap[P],
  fetchImpl?: typeof fetch
): IGeocodingConnector {
  switch (provider) {
    case 'google':
      return new GoogleGeocodingConnector(config as ProviderConfigMap['google'], fetchImpl);
    case 'mapbox':
      return new MapboxGeocodingConnector(config as ProviderConfigMap['mapbox'], fetchImpl);
    case 'here':
      return new HereGeocodingConnector(config as ProviderConfigMap['here'], fetchImpl);
    case 'esri':
      return new EsriGeocodingConnector(config as ProviderConfigMap['esri'], fetchImpl);
    case 'tomtom':
      return new TomTomGeocodingConnector(config as ProviderConfigMap['tomtom'], fetchImpl);
    default:
      throw new Error(`Unknown geocoding provider: ${provider}`);
  }
}
