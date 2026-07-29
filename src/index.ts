// Per-provider input augmentations (`RoutingOptionsMap`, `IsochroneOptionsMap`,
// `AutocompleteOptionsMap`, …) are declared in each provider's `<id>.config.ts`. A
// `declare module` block only applies if the file declaring it is part of the
// consumer's compilation, and config types are re-exported below — which is what
// makes those files reachable. Declaring an augmentation in a `<id>.types.ts`
// instead typechecks in-repo and is INVISIBLE to consumers; that is how Mapbox's
// `sessionToken` shipped unusable. `check:dist` gates this by typechecking a real
// consumer against the built package.

// === Unified facades (preferred API) ===
export { Routing } from './facades/routing.facade';
export { Matrix } from './facades/matrix.facade';
export { Geocoding } from './facades/geocoding.facade';
export { Isochrone } from './facades/isochrone.facade';

// === Types & interfaces (includes ConnectorError + ProviderCode) ===
export * from './types';

// === Polyline utilities (public API) ===
export {
  encodePolyline,
  decodePolyline,
  decodeFlexPolyline,
  encodeEsriPaths,
} from './utils';
export type { EsriPathsGeometry } from './utils';

// === Per-provider connector classes (direct import when bypassing facade) ===
export { OsrmRoutingConnector, OsrmMatrixConnector } from './providers/osrm';
export type { OsrmConfig, OsrmExcludeClass } from './providers/osrm';
export { GoogleRoutingConnector, GoogleMatrixConnector, GoogleGeocodingConnector } from './providers/google';
export type { GoogleConfig } from './providers/google';
export { MapboxRoutingConnector, MapboxMatrixConnector, MapboxGeocodingConnector, MapboxIsochroneConnector } from './providers/mapbox';
export type { MapboxConfig } from './providers/mapbox';
export { HereRoutingConnector, HereMatrixConnector, HereGeocodingConnector, HereIsochroneConnector } from './providers/here';
export type { HereConfig } from './providers/here';
export { EsriRoutingConnector, EsriMatrixConnector, EsriGeocodingConnector, EsriIsochroneConnector } from './providers/esri';
export type { EsriConfig } from './providers/esri';
export { TomTomRoutingConnector, TomTomMatrixConnector, TomTomGeocodingConnector, TomTomIsochroneConnector } from './providers/tomtom';
export type { TomTomConfig } from './providers/tomtom';
