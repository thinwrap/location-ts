import type { GoogleConfig } from '../providers/google';
import type { MapboxConfig } from '../providers/mapbox';
import type { HereConfig } from '../providers/here';
import type { EsriConfig } from '../providers/esri';
import type { OsrmConfig } from '../providers/osrm';
import type { TomTomConfig } from '../providers/tomtom';

export interface ProviderConfigMap {
  google: GoogleConfig;
  mapbox: MapboxConfig;
  here: HereConfig;
  esri: EsriConfig;
  osrm: OsrmConfig;
  tomtom: TomTomConfig;
}

export type RoutingProvider = 'google' | 'mapbox' | 'here' | 'esri' | 'osrm' | 'tomtom';
export type MatrixProvider = 'google' | 'mapbox' | 'here' | 'esri' | 'osrm' | 'tomtom';
export type GeocodingProvider = 'google' | 'mapbox' | 'here' | 'esri' | 'tomtom';
export type IsochroneProvider = 'mapbox' | 'here' | 'esri' | 'tomtom';

/**
 * Providers implementing `placeDetails`. All five geocoding providers do, but the
 * union exists rather than reusing `GeocodingProvider` so a provider that later
 * lacks the operation can be dropped from it without touching the other three.
 * Precedent: `IsochroneProvider` already ships 4/6.
 */
export type PlaceDetailsProvider = 'google' | 'mapbox' | 'here' | 'esri' | 'tomtom';
