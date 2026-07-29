export interface GoogleRoutesResponse {
  routes: Array<{
    legs: Array<{
      distanceMeters: number;
      duration: string;
      staticDuration?: string;
    }>;
    distanceMeters: number;
    duration: string;
    staticDuration?: string;
    polyline: { encodedPolyline: string };
    optimizedIntermediateWaypointIndex?: number[];
  }>;
}

/**
 * Single element from Google's RouteMatrix v2 NDJSON-streamed response.
 * One object per (originIndex, destinationIndex) pair. Per the connector
 * requests field mask `originIndex,destinationIndex,distanceMeters,duration,status`;
 * `status` is typically absent on success and populated on per-cell failure.
 */
export interface GoogleRouteMatrixElement {
  originIndex: number;
  destinationIndex: number;
  distanceMeters?: number;
  duration?: string;
  status?: GoogleRouteMatrixStatus;
  // Independent of `status`: `ROUTE_EXISTS` vs `ROUTE_NOT_FOUND`. A cell can be
  // status-OK with `ROUTE_NOT_FOUND` and no distanceMeters/duration.
  condition?: string;
}

/** RPC-style per-cell status; `code === 0` means OK (cell succeeded). */
export interface GoogleRouteMatrixStatus {
  code?: number;
  message?: string;
}

export interface GoogleGeocodeResponse {
  status: string;
  results: Array<{
    formatted_address: string;
    geometry: {
      location: { lat: number; lng: number };
      viewport?: {
        southwest: { lat: number; lng: number };
        northeast: { lat: number; lng: number };
      };
    };
    place_id?: string;
  }>;
  error_message?: string;
}

/**
 * Legacy Place Autocomplete (`/maps/api/place/autocomplete/json`) response.
 * Retained for reference; migrated the connector to the NEW API
 * ({@link GooglePlacesAutocompleteNewResponse}).
 */
export interface GoogleAutocompleteResponse {
  status: string;
  predictions: Array<{
    description: string;
    place_id: string;
  }>;
  error_message?: string;
}

/**
 * Places Autocomplete NEW response shape (POST
 * `https://places.googleapis.com/v1/places:autocomplete`). See.
 */
export interface GooglePlacesAutocompleteNewResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      /** Default-on for Places Autocomplete — no field mask or extra cost. */
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
}

// Per-provider INPUT augmentations for Google (`sessionToken`) deliberately do
// NOT live here — see `google.config.ts`. A `declare module` block only applies
// if its file is part of the consumer's compilation, and nothing in the emitted
// type graph imports this module (the connectors reference it in comments only).
