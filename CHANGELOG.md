# Changelog

All notable changes to `@thinwrap/location` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-04

First public release of `@thinwrap/location` — the lightweight, SDK-free
location API wrapper for routing, distance matrix, geocoding, and isochrone
across six providers.

### Public surface (locked at v1.0)

- **4 unified facades**: `Routing`, `Matrix`, `Geocoding`, `Isochrone`.
- **21 per-provider × operation connectors**:
  - Google: `GoogleRoutingConnector`, `GoogleMatrixConnector`, `GoogleGeocodingConnector` (3).
  - Mapbox: `MapboxRoutingConnector`, `MapboxMatrixConnector`, `MapboxGeocodingConnector`, `MapboxIsochroneConnector` (4).
  - HERE: `HereRoutingConnector`, `HereMatrixConnector`, `HereGeocodingConnector`, `HereIsochroneConnector` (4).
  - ESRI: `EsriRoutingConnector`, `EsriMatrixConnector`, `EsriGeocodingConnector`, `EsriIsochroneConnector` (4).
  - TomTom: `TomTomRoutingConnector`, `TomTomMatrixConnector`, `TomTomGeocodingConnector`, `TomTomIsochroneConnector` (4).
  - OSRM: `OsrmRoutingConnector`, `OsrmMatrixConnector` (2).
- **Polyline utilities**: `encodePolyline`, `decodePolyline`, `decodeFlexPolyline`, `encodeEsriPaths`.
- **Error model**: `ConnectorError` + 11-value `ProviderCode` type (6 canonical
  + 5 location-extended).
- **Coordinate type**: `LatLng`.
- **Config types**: `GoogleConfig`, `MapboxConfig`, `HereConfig`, `EsriConfig`,
  `TomTomConfig`, `OsrmConfig`.

### Properties

- **Zero runtime dependencies** — uses native `fetch` (Node ≥18).
- **Sigstore provenance** — `npm publish --provenance` via OIDC; no
  long-lived npm token consumed.
- **Wrapper holds no state** — no token cache, no connection pool, no retry
  buffer. Every operation is a single function call from input to output.
  Consumers compose retry / caching / lifecycle out-of-band.
- **Bring-your-own `fetch`** — third constructor argument accepts any
  fetch-compatible function for tracing, mocking, or routing through
  `undici`.
- **Bundle-size discipline**:
  - Single-provider tree-shaken import: < 12 KB gzipped.
  - All-provider import: < 40 KB gzipped.
  - Polyline-utilities-only: < 5 KB gzipped.
- **Dual build**: ESM (`import`) + CJS (`require`). Full TypeScript types.
- **Cross-language parity** with `thinwrap/location` (Packagist) — identical
  facade names, error model, result shapes, provider IDs.

### Baseline-coverage discipline

The unified facade surface includes only features ≥90% of providers natively
support. Sub-baseline fields are accessible via provider-id-narrowed augmented
types and the `_passthrough` escape hatch.

### Migration

This is the first public release under the `@thinwrap/location` name; there
are no prior published versions.

The README's Migration section documents shifting from `googleapis` or
`@mapbox/maps-sdk-js`.

### Cross-language

Companion package `thinwrap/location` publishes simultaneously on Packagist
with identical facade names, error model, and result shapes.

[1.0.0]: https://github.com/thinwrap/location-ts/releases/tag/v1.0.0
