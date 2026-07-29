export interface TomTomConfig {
  apiKey: string;
}

// This augmentation lives in the config module because a `declare module` block only
// applies when the file declaring it is part of the consumer's compilation. Config
// types are re-exported from the package entry, so this file is always reachable;
// `tomtom.types.ts` is imported by nothing in the emitted type graph.
//
// The base isochrone `travelMode` is `'driving' | 'walking'`, because only TomTom and
// Mapbox have native bicycle support. Both widen it back to include `'cycling'`;
// HERE and ESRI stay at base.

declare module '../../types/isochrone.interface' {
  interface IsochroneOptionsMap {
    tomtom: Omit<
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
      import('../../types').IIsochroneOptions,
      'travelMode'
    > & {
      travelMode?: 'driving' | 'walking' | 'cycling';
    };
  }
}
