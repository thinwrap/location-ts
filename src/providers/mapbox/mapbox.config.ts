export interface MapboxConfig {
  accessToken: string;
}

// Mapbox Search Box bills per SESSION: `suggest` calls and the `retrieve` that
// follows count as one billable session only when they carry the same
// `session_token` (required on both endpoints). A fresh token per call bills each
// call as its own session. The wrapper holds no state, so the caller threads the
// value through; when it is absent the connector generates a UUIDv4 per call.
//
// This block lives in the config module rather than `mapbox.types.ts` for the reason
// documented in `google.config.ts`: an augmentation in a module nothing imports is
// silently absent from the published types.

declare module '../../types/geocoding.interface' {
  interface AutocompleteOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    mapbox: import('../../types').IAutocompleteOptions & {
      /**
       * Search Box `session_token` grouping this `/suggest` call with the rest of
       * one user interaction and the `placeDetails()` (`/retrieve`) that ends it.
       *
       * Mapbox recommends a UUIDv4. Generate one per user interaction and reuse it
       * for every keystroke and the final `placeDetails()` — the wrapper is
       * stateless and cannot correlate the calls for you. Omitted, the connector
       * sends a fresh UUIDv4, so each call bills as its own session.
       */
      sessionToken?: string;
    };
  }

  interface PlaceDetailsOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    mapbox: import('../../types').IPlaceDetailsOptions & {
      /**
       * The `sessionToken` used for the preceding `autocomplete()` calls — Mapbox
       * requires `/retrieve` to carry the same `session_token` as the `/suggest`
       * calls before it.
       *
       * Pass the same value to both so Mapbox bills one Search Box session.
       * Omitted, the connector sends a fresh UUIDv4 (the parameter is required),
       * which bills the retrieve as a session of its own.
       */
      sessionToken?: string;
    };
  }
}

// The base isochrone `travelMode` is `'driving' | 'walking'`, because only Mapbox
// and TomTom have native bicycle support. Both widen it back to include
// `'cycling'`; HERE and ESRI stay at base.

declare module '../../types/isochrone.interface' {
  interface IsochroneOptionsMap {
    mapbox: Omit<
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
      import('../../types').IIsochroneOptions,
      'travelMode'
    > & {
      travelMode?: 'driving' | 'walking' | 'cycling';
    };
  }
}
