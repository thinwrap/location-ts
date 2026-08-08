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
 * The vehicle classes HERE accepts beyond the three the base
 * {@link IRoutingOptions.travelMode} carries. Valid on Routing v8 *and* Matrix
 * v8 — the two services publish the same set.
 *
 * `bus` and `privateBus` are distinct, not synonyms: `bus` may drive through
 * bus-restricted and bus-exclusive streets, while `privateBus` uses those
 * streets only where a waypoint sits on one (the pick-up / drop-off case).
 * HERE lists `bicycle`, `bus` and `privateBus` as Beta with limited
 * functionality.
 *
 * **`privateBus` is incompatible with `optimize: true`.** Optimization runs
 * through the legacy `findsequence2` endpoint, whose `mode` grammar accepts
 * only `car`, `truck`, `pedestrian`, `bus`, `bicycle`, `scooter` and `taxi`;
 * `privateBus` comes back as HTTP 400 `Unknown transport mode` (verified
 * live 2026-08-08). Use `bus` when you need optimization.
 *
 * HERE's routing enum has one further value, `networkRestrictedTruck`, which
 * is deliberately absent: it is rejected by both `findsequence2` and Matrix
 * v8, and on `/v8/routes` it 400s unless the caller also sends
 * `networkRestrictedTruck[permittedNetworks]`, which this connector does not
 * model. Reach it through `_passthrough.query` if you need it.
 *
 * @see HereRoutingOptions
 * @see https://docs.here.com/routing/docs/routing-v8-bus-taxi-routing
 */
export type HereTransportMode =
  | 'car'
  | 'truck'
  | 'pedestrian'
  | 'bicycle'
  | 'scooter'
  | 'taxi'
  | 'bus'
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
