import type { IRoutingOptions } from '../../types';

export interface HereRouteResponse {
  routes: Array<{
    sections: Array<{
      polyline: string;
      summary: {
        length: number;
        duration: number;
        /**
         * Traffic-free duration. HERE ships it inside `summary` (no extra
         * `return=` value needed), but it is only surfaced when the caller opts
         * in via `include: ['durationWithoutTraffic']`.
         */
        baseDuration?: number;
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
 * The vehicle classes HERE Routing v8 accepts beyond the three the base
 * {@link IRoutingOptions.travelMode} carries.
 *
 * @see HereRoutingOptions
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

// The `RoutingOptionsMap` augmentation binding `here` to `HereRoutingOptions`
// deliberately does NOT live here — see `here.config.ts`. A `declare module` block
// only applies if its file is part of the consumer's compilation, and nothing in
// the emitted type graph imports this module.

export interface HereMatrixResponse {
  matrix: {
    numOrigins: number;
    numDestinations: number;
    travelTimes: number[];
    distances: number[];
    // Per-cell status parallel to travelTimes/distances (present when any cell
    // failed). 0 = OK, 3 = "matrix cell computed with a violated constraint"
    // (still a usable value); any other non-zero code marks the cell's
    // travelTimes/distances value as unspecified.
    errorCodes?: number[];
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
