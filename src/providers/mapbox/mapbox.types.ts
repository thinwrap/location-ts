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
    /**
     * The POI/street name distinct from the full address. Returned by Search Box
     * `retrieve`; absent on plain Geocoding v6 features.
     */
    name?: string;
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
  /**
   * The address portion without the `name` — Search Box's secondary display line,
   * and the source of `structuredFormat.secondaryText`.
   */
  place_formatted?: string;
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

// Mapbox's INPUT augmentations (`sessionToken`, and widening the isochrone
// `travelMode` back to include `'cycling'`) deliberately do NOT live here — see
// `mapbox.config.ts`. A `declare module` block only applies if its file is part of
// the consumer's compilation, and nothing in the emitted type graph imports this
// module, so an augmentation here is invisible from the published package.
