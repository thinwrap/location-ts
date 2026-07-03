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
  ProviderConfigMap,
  GeocodingProvider,
} from '../types';
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
