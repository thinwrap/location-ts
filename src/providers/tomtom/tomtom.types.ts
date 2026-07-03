export interface TomTomRouteResponse {
  routes: Array<{
    summary: {
      lengthInMeters: number;
      travelTimeInSeconds: number;
      trafficDelayInSeconds?: number;
    };
    legs: Array<{
      summary: {
        lengthInMeters: number;
        travelTimeInSeconds: number;
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

// --------------------------------------------------------------------------
// IsochroneOptionsMap augmentation
//
// the base `IIsochroneOptions.travelMode` is narrowed to
// `'driving' | 'walking'`. TomTom is 1 of 2 providers (alongside Mapbox) with
// native bicycle support, so it widens `travelMode` back to include
// `'cycling'` here via TypeScript module augmentation. HERE and ESRI do not
// augment — their narrowed type stays at base.
// --------------------------------------------------------------------------

import type { IIsochroneOptions } from '../../types';

declare module '../../types/isochrone.interface' {
  interface IsochroneOptionsMap {
    tomtom: Omit<IIsochroneOptions, 'travelMode'> & {
      travelMode?: 'driving' | 'walking' | 'cycling';
    };
  }
}
