export interface HereConfig {
  apiKey: string;
}

// HERE's routing-input augmentation lives in the config module because a
// `declare module` block only applies when the file declaring it is part of the
// consumer's compilation. Config types are re-exported from the package entry, so
// this file is always reachable; `here.types.ts` is imported by nothing in the
// emitted type graph, and an augmentation declared there typechecks in-repo while
// being invisible from the published package.

declare module '../../types/routing.interface' {
  interface RoutingOptionsMap {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import required: a top-level `import type` is elided from the emit
    here: import('./here.types').HereRoutingOptions;
  }
}
