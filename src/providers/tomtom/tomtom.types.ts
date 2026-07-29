export interface TomTomRouteResponse {
  routes: Array<{
    summary: {
      lengthInMeters: number;
      travelTimeInSeconds: number;
      trafficDelayInSeconds?: number;
      /** Only returned when `computeTravelTimeFor=all` is requested. */
      noTrafficTravelTimeInSeconds?: number;
    };
    legs: Array<{
      summary: {
        lengthInMeters: number;
        travelTimeInSeconds: number;
        /** Only returned when `computeTravelTimeFor=all` is requested. */
        noTrafficTravelTimeInSeconds?: number;
      };
      points: Array<{ latitude: number; longitude: number }>;
    }>;
    sections?: Array<{
      startPointIndex: number;
      endPointIndex: number;
      sectionType: string;
      travelMode: string;
    }>;
  }>;
  optimizedWaypoints?: Array<{
    providedIndex: number;
    optimizedIndex: number;
  }>;
}

export interface TomTomMatrixResponse {
  data: Array<{
    originIndex: number;
    destinationIndex: number;
    routeSummary?: {
      lengthInMeters: number;
      travelTimeInSeconds: number;
      trafficDelayInSeconds?: number;
    };
    detailedError?: {
      code: string;
      message: string;
    };
  }>;
  statistics?: {
    totalCount: number;
    successes: number;
    failures: number;
  };
}

export interface TomTomGeocodeResponse {
  summary: { numResults: number; totalResults: number };
  results: Array<{
    type: string;
    id: string;
    score: number;
    address: {
      freeformAddress: string;
      streetName?: string;
      municipality?: string;
      countryCode?: string;
    };
    position: { lat: number; lon: number };
    /**
     * Present for POI results (and on the `place.json` lookup); absent for plain
     * street/address results, which have no distinct name.
     */
    poi?: { name?: string };
  }>;
}

export interface TomTomReverseGeocodeResponse {
  summary: { numResults: number };
  addresses: Array<{
    address: {
      freeformAddress: string;
      streetName?: string;
      municipality?: string;
      countryCode?: string;
    };
    position: string; // "lat,lon" as string
    id?: string;
  }>;
}

export interface TomTomSearchResponse {
  summary: { numResults: number; totalResults: number };
  results: Array<{
    type: string;
    id: string;
    address: {
      freeformAddress: string;
    };
    position: { lat: number; lon: number };
    poi?: { name: string };
  }>;
}

export interface TomTomReachableRangeResponse {
  reachableRange: {
    center: { latitude: number; longitude: number };
    boundary: Array<{ latitude: number; longitude: number }>;
  };
}

// TomTom's isochrone `travelMode` widening deliberately does NOT live here — see
// `tomtom.config.ts`. A `declare module` block only applies if its file is part of
// the consumer's compilation, and nothing in the emitted type graph imports this
// module, so an augmentation here is invisible from the published package.
