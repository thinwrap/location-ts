export interface GoogleConfig {
  apiKey: string;
}

// Google Places Autocomplete is billed per SESSION when a token ties the keystroke
// requests to the `placeDetails()` call that closes them, and per REQUEST when it
// does not — so a keystroke-driven UI without a token is billed once per character
// typed. The wrapper holds no state, so the caller threads the value through. Wire
// spelling differs per leg: a body field on autocomplete, a query param on Place
// Details.
//
// This block lives in the config module, not `google.types.ts`, because a module
// augmentation only applies if its file is in the CONSUMER's compilation and nothing
// in the emitted type graph imports `*.types.ts`. `GoogleConfig` is re-exported from
// `src/index.ts`, so this module always loads. The inline `import(...)` types matter
// for the same reason: a top-level `import type` used only inside the block is
// elided from the emit. `check:dist` asserts both.

declare module '../../types/geocoding.interface' {
  interface AutocompleteOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    google: import('../../types').IAutocompleteOptions & {
      /**
       * Session token grouping this keystroke with the rest of one user
       * interaction, closed by the `placeDetails()` call carrying the SAME value.
       *
       * Google documents a v4 UUID. Generate it yourself and reuse it for every
       * keystroke of one lookup — the wrapper is stateless and cannot correlate
       * the calls for you. Omit it and each keystroke is billed as its own
       * request.
       */
      sessionToken?: string;
    };
  }

  interface PlaceDetailsOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    google: import('../../types').IPlaceDetailsOptions & {
      /**
       * The `sessionToken` used for the preceding `autocomplete()` calls.
       *
       * Passing it closes the session so the whole interaction is billed once
       * instead of per keystroke. A fresh value, or none, leaves the autocomplete
       * requests billed individually.
       */
      sessionToken?: string;
    };
  }
}
