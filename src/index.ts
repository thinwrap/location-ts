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
export type { OsrmConfig } from './providers/osrm';
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
