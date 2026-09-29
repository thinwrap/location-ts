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
export type {
  HereConfig,
  // The narrowed HERE input shapes. The module augmentation already types
  // `transportMode` at the call site, so these are only needed to NAME the
  // vocabulary — declaring a variable, or a helper that takes one.
  HereRoutingOptions,
  HereMatrixOptions,
  HereTransportMode,
} from './providers/here';
export { EsriRoutingConnector, EsriMatrixConnector, EsriGeocodingConnector, EsriIsochroneConnector } from './providers/esri';
export type { EsriConfig } from './providers/esri';
export { TomTomRoutingConnector, TomTomMatrixConnector, TomTomGeocodingConnector, TomTomIsochroneConnector } from './providers/tomtom';
export type { TomTomConfig } from './providers/tomtom';

// === Default vendor lists that `_passthrough` replaces ===
// A passthrough value for a list-valued vendor parameter REPLACES the connector's
// list, so these are published for a caller to spread and append to instead of
// retyping them.
export {
  GOOGLE_ROUTES_FIELD_MASK,
  GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC,
  GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER,
  GOOGLE_MATRIX_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME,
} from './providers/google';
export { HERE_ROUTING_RETURN, HERE_MATRIX_ATTRIBUTES } from './providers/here';
export { MAPBOX_MATRIX_ANNOTATIONS } from './providers/mapbox';
export { OSRM_TABLE_ANNOTATIONS } from './providers/osrm';
export {
  ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING,
  ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING,
  ESRI_MATRIX_ACCUMULATE_ATTRIBUTES,
} from './providers/esri';
