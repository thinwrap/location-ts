export interface MapboxDirectionsResponse {
  code: string;
  routes: Array<{
    geometry: string;
    legs: Array<{
      distance: number;
      duration: number;
    }>;
    distance: number;
    duration: number;
  }>;
  waypoints: Array<{
    waypoint_index?: number;
    name: string;
  }>;
}

export interface MapboxMatrixResponse {
  code: string;
  durations: (number | null)[][];
  distances: (number | null)[][];
}

export interface MapboxGeocodingResponse {
  type: string;
  features: Array<{
    place_name: string;
    center: [number, number]; // [lng, lat]
    id: string;
  }>;
}

/**
 * Mapbox Geocoding v6 forward/reverse response shape.
 *
 * v6 is GeoJSON-shaped: each feature has `geometry.coordinates` (GeoJSON
 * `[lng, lat]` order), and the connector reads identifiers + viewport from
 * `properties` (`mapbox_id`, `full_address`, `bbox`). `place_name` is kept as
 * a fallback for older response variants but `properties.full_address` is the
 * preferred display string.
 */
export interface MapboxGeocodingV6Feature {
  geometry?: {
    type?: string;
    coordinates?: [number, number]; // GeoJSON [lng, lat]
  };
  properties?: {
    mapbox_id?: string;
    full_address?: string;
    /** v6 viewport: `[west, south, east, north]` (lng/lat pairs). */
    bbox?: [number, number, number, number];
  };
  /** Older response shape; preferred field is `properties.full_address`. */
  place_name?: string;
}

export interface MapboxGeocodingV6Response {
  type?: string;
  features?: MapboxGeocodingV6Feature[];
}

/**
 * Mapbox Searchbox `/suggest` response. Searchbox is a separate API from
 * Geocoding v6 and is used by for `.autocomplete` only.
 */
export interface MapboxSearchboxSuggestion {
  name?: string;
  full_address?: string;
  mapbox_id?: string;
}

export interface MapboxSearchboxSuggestResponse {
  suggestions?: MapboxSearchboxSuggestion[];
}

export interface MapboxIsochroneResponse {
  type: string;
  features: Array<{
    properties: {
      contour: number;
      metric: string;
    };
    geometry: {
      type: string;
      coordinates: number[][][];
    };
  }>;
}

// --------------------------------------------------------------------------
// IsochroneOptionsMap augmentation
//
// the base `IIsochroneOptions.travelMode` is narrowed to
// `'driving' | 'walking'`. Mapbox is 1 of 2 providers (alongside TomTom) with
// native bicycle support, so it widens `travelMode` back to include
// `'cycling'` here via TypeScript module augmentation. HERE and ESRI do not
// augment — their narrowed type stays at base.
// --------------------------------------------------------------------------

import type { IIsochroneOptions } from '../../types';

declare module '../../types/isochrone.interface' {
  interface IsochroneOptionsMap {
    mapbox: Omit<IIsochroneOptions, 'travelMode'> & {
      travelMode?: 'driving' | 'walking' | 'cycling';
    };
  }
}
