import type { IRoutingOptions } from '../../types';

export interface HereRouteResponse {
  routes: Array<{
    sections: Array<{
      polyline: string;
      summary: {
        length: number;
        duration: number;
      };
    }>;
  }>;
}

export interface HereSequenceResponse {
  results: Array<{
    waypoints: Array<{
      id: string;
      lat: number;
      lng: number;
      sequence: number;
    }>;
  }>;
}

/**
 * HERE Routing v8 supports a richer set of vehicle classes than the base
 * {@link IRoutingOptions.travelMode}. Per (canonical example) and
 * of, HERE narrows `RoutingOptionsMap['here']` to add an
 * optional `transportMode` field carrying these extra modes.
 *
 * When set on input, `transportMode` overrides the base `travelMode` mapping
 * inside the connector.
 *
 * @see HereRoutingOptions
 * @see RoutingOptionsMap
 */
export type HereTransportMode =
  | 'car'
  | 'truck'
  | 'pedestrian'
  | 'bicycle'
  | 'scooter'
  | 'taxi'
  | 'privateBus';

/**
 * Provider-narrowed {@link IRoutingOptions} for HERE. Adds the optional
 * {@link HereTransportMode}-typed `transportMode` field.
 */
export interface HereRoutingOptions extends IRoutingOptions {
  /** When set, overrides the base `travelMode` mapping at the wire level. */
  transportMode?: HereTransportMode;
}

declare module '../../types/routing.interface' {
  interface RoutingOptionsMap {
    here: HereRoutingOptions;
  }
}

export interface HereMatrixResponse {
  matrix: {
    numOrigins: number;
    numDestinations: number;
    travelTimes: number[];
    distances: number[];
  };
}

/**
 * A single HERE Geocoding v7 `items[]` entry. `title` is the human-readable
 * label (used as the primary `formattedAddress` source); `address.label` is
 * the structured fallback. `mapView` carries the candidate's bounding box
 * which the normalizer projects into the base `viewport` shape.
 */
export interface HereGeocodeItem {
  title: string;
  address?: { label?: string };
  position: { lat: number; lng: number };
  id: string;
  mapView?: { south: number; west: number; north: number; east: number };
}

export interface HereGeocodeResponse {
  items: HereGeocodeItem[];
}

/**
 * A single HERE Autosuggest `items[]` entry. `title` is the suggestion's
 * display text; `address.label` is an optional structured fallback when the
 * suggestion type carries an address.
 */
export interface HereAutocompleteItem {
  title: string;
  id: string;
  address?: { label?: string };
}

export interface HereAutocompleteResponse {
  items: HereAutocompleteItem[];
}

export interface HereIsolineResponse {
  isolines: Array<{
    range: { type: string; value: number };
    polygons: Array<{
      outer: string;
    }>;
  }>;
}
