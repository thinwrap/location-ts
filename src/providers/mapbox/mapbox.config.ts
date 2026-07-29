export interface MapboxConfig {
  accessToken: string;
}

// Mapbox Search Box bills per SESSION: a `suggest` call and the `retrieve` that
// follows count as one billable session only when they carry the same
// `session_token`. Omitting it, or passing a fresh one, bills two. The wrapper holds
// no state, so the caller threads the value through both calls.
//
// This block lives in the config module rather than `mapbox.types.ts` for the reason
// documented in `google.config.ts`: an augmentation in a module nothing imports is
// silently absent from the published types.

declare module '../../types/geocoding.interface' {
  interface PlaceDetailsOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    mapbox: import('../../types').IPlaceDetailsOptions & {
      /**
       * The `session_token` used for the preceding `autocomplete()` call.
       *
       * Pass the same value to both so Mapbox bills one Search Box session
       * instead of two. Generate it yourself (a UUID per user interaction) — the
       * wrapper is stateless and cannot correlate the calls for you.
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
