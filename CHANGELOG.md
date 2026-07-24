# Changelog

All notable changes to `@thinwrap/location` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-07-24

### Added

- **ESRI walking travel mode.** `travelMode: 'walking'` now selects ESRI's
  pedestrian network across routing, matrix, and isochrone by sending the full
  ArcGIS "Walking Time" travel-mode definition — a bare `"Walking"` token is
  ignored by the service, which silently keeps the default driving impedance.
  The mode-dependent impedance column (`WalkTime`) is read back correctly.
  `travelMode: 'cycling'` raises `unsupported_travel_mode`; ArcGIS's World
  network services do not provide a cycling mode.

### Changed

- **HERE Matrix (v8)** now requests `Accept-Encoding: gzip` and transparently
  gunzips the compressed matrix payload — HERE returns the matrix result
  gzip-encoded (406 without the header) and the default undici transport does
  not auto-decompress it.

### Fixed

- **ESRI OD cost matrix** now sends valid `origins` / `destinations` FeatureSets
  and reads the real `Total_TravelTime` / `Total_Kilometers` output attributes
  (kilometres converted to metres), replacing a malformed request/response path
  that returned no usable results.
- **Connector hardening (second review pass)** across the ESRI, Google, HERE,
  Mapbox, OSRM, and TomTom connectors — additional malformed-`200`-response
  guards and coordinate-edge validation so every failure surfaces as a
  `ConnectorError` rather than a raw `TypeError`.

### Internal

- `node:zlib` is externalised in the `size-limit` config (alongside
  `node:crypto`) so the bundle-size CI gate resolves the Node built-in. No
  runtime dependency is added — the zero-dependency guarantee is intact.

## [1.0.1] — 2026-07-20

### Changed

- **Google routing & matrix** now classify an invalid or restricted API key as
  `auth_failed` (previously `invalid_request`). Google's Routes/RouteMatrix APIs
  return HTTP `400 INVALID_ARGUMENT` for a bad key, so the connectors now read
  the structured `google.rpc.ErrorInfo` `reason` from `error.details[]` (e.g.
  `API_KEY_INVALID`, `API_KEY_*_BLOCKED`, `SERVICE_DISABLED`) and map auth/quota
  reasons before falling back to the HTTP-status mapping. Absent an `ErrorInfo`,
  behaviour is unchanged.
- **Per-connector READMEs** no longer carry a YAML frontmatter block — the
  metadata GitHub rendered as a table but nothing consumed. The rate-limit-docs
  links it held now live in the README prose; the frontmatter validator
  (`scripts/validate-frontmatter.mjs`), its schema, and the CI gate that ran it
  have been removed.

### Fixed

- **Mapbox routing** now rejects a call with fewer than two waypoints up front
  with a clean `invalid_request` `ConnectorError`, matching every other routing
  connector (previously it built a malformed request and surfaced an opaque
  vendor error).
- **Non-finite coordinates** (`NaN` / `Infinity`) are now rejected with
  `invalid_request` across every coordinate path — reverse geocoding, routing
  waypoints (including Mapbox optimized trips), isochrone centers, and the ESRI
  FeatureSet builders — instead of reaching the wire (where `NaN` serialized as
  JSON `null` or the literal `"NaN"`).
- **Routing result normalizers** (Google, HERE, TomTom) no longer throw a raw
  `TypeError` when a `200` response omits an expected nested field; malformed
  bodies degrade to safe defaults, preserving the "every failure surfaces as a
  `ConnectorError`" contract.

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
