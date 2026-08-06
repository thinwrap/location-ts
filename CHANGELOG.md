# Changelog

All notable changes to `@thinwrap/location` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.2] — 2026-08-06

### Fixed

- **An error body the host's dispatcher buffered while still compressed no longer
  degrades error classification silently.** A dispatcher-level interceptor sits
  *below* fetch's content-decoding, so it buffers raw gzip bytes and text-decodes
  them; the result is irrecoverable (measured on a real gzipped 400: 16 of 66 bytes
  replaced with U+FFFD, the `1f 8b` magic destroyed, inflation impossible in any
  re-encoding — and undici's own `decompress()` interceptor does not help, in any
  composition order).

  Rather than pass mojibake through, `BaseConnector` now substitutes a namespaced
  marker, which every connector already routes into `ConnectorError.cause`:

  ```json
  { "_thinwrapErrorBodyUnavailable": "gzip" }
  ```

  Status, provider code and `Retry-After` were already surviving; this makes the
  *reason* for a missing `providerMessage` explicit instead of leaving a silent gap.
  Uncompressed and `identity`-encoded bodies are untouched.

- **Google no longer returns a confident `invalid_request` when it cannot see the
  body.** Google answers HTTP 400 for both an invalid API key and a malformed
  request; only `error.details[].reason` separates them, and the response headers
  are byte-identical (verified live). With the body destroyed, the status-only
  fallback was reporting `invalid_request` — a wrong code, stated confidently, on
  what is actually an auth failure. All three Google connectors now report `unknown`
  in that case. Behaviour on a normal host is unchanged.

  Live-verified across all five providers via the new `probe:dispatcher` playground
  script. Two of six cases gzip their error bodies (HERE `findsequence2`, Google).
  The only way to keep vendor error text is not to compose
  `interceptors.responseError()` onto a shared dispatcher.

### Documentation

- The **Bring your own `fetch`** section now states the transport contract (a non-2xx must
  be returned, not thrown) and warns that injecting a `fetch` does **not** isolate you from
  the host process — `globalThis.fetch` and `undici.fetch` both dispatch through undici's
  process-global dispatcher. It shows the isolated alternative, verified live to restore
  both the correct provider code and the vendor message:

  ```ts
  const isolated = new Agent();
  const fetchImpl = ((url, init) =>
    undiciFetch(url as string, { ...init, dispatcher: isolated })) as typeof fetch;
  ```

  This was previously documented only in `.ai/ARCHITECTURE.md`, which consumers never see.

## [1.2.1] — 2026-08-06

### Fixed

- **HERE optimized routing carrying a `departureTime` failed outright** (regression introduced
  in 1.2.0). The `findsequence2` leg emitted a millisecond-precision `departure`
  (`2026-08-07T03:06:00.000Z`) and the legacy WPS endpoint answers HTTP 400 *Bad Format for
  Date and Time*. It now emits seconds precision with the zone designator
  (`2026-08-07T03:06:00Z`), matching HERE's own documented example. `/v8/routes` is unchanged
  — it accepts the fractional form.
- **Every HTTP error collapsed into `provider_unavailable` with a null status when the host
  application's `fetch` rejects on a non-2xx.** Node's undici dispatcher is process-global and
  invisible to the injected `fetchImpl`, so a host composing `interceptors.responseError()`
  turned every 400/429/503 from every provider into an apparent transport failure —
  `raiseHttpError` never ran. `BaseConnector` now rebuilds the `Response` from such a
  rejection, so each connector's own status mapping, `providerMessage` and `Retry-After`
  handling run unchanged. Genuine transport failures are classified exactly as before.
- **`ConnectorError.cause.raw` carried only `name`**, which is `TypeError` for every undici
  failure — DNS, reset, TLS, aborted redirect — and so identified nothing. It now also carries
  `code` (`ECONNRESET`, `UND_ERR_RESPONSE`, `ENOTFOUND`, …), `causeName` and `statusCode` when
  present. Only identifier-shaped values are accepted, so a URL or credential still cannot
  reach it, and the raw message and error object remain suppressed.
- **HERE `findsequence2` error text was discarded.** Its legacy envelope
  (`{"results":null,"errors":["…"],"responseCode":"400"}`) carries neither `title` nor `cause`,
  so the caller saw a bare `failed: 400`. Both the HTTP-error path and the
  HTTP-200-with-`responseCode` path now surface it.
- **Mapbox `depart_at` emitted a millisecond value**, which is not one of the three ISO 8601
  forms Mapbox documents for that parameter. Now seconds precision.

## [1.2.0] — 2026-07-28

Driven by external-consumer feedback, applied across all four language siblings. Additive or
correctness only. Per-provider detail lives in the connector READMEs under `src/providers/`.

### Added

- `countryFilter` on `autocomplete()` — all five geocoders. Google's ccTLD codes (`GB` →
  `uk`) and 15-code cap are handled; it also suppresses Google's *query* predictions.
- `placeDetails()` on the `Geocoding` facade and all five geocoding connectors — resolves an
  `autocomplete()` `placeId` to an `IGeocodeCandidate`. `include: ['name']` gates Google's
  `displayName`, whose field mask drives the SKU tier.
- `sessionToken` on Google `autocomplete()`/`placeDetails()` and Mapbox `placeDetails()` —
  both vendors bill per **session** with one and per request without, so a keystroke-driven
  UI without a token is billed once per character typed.
- `structuredFormat?` on `IAutocompletePrediction` (`mainText`/`secondaryText`). Never
  synthesized, so absent for TomTom street results and for Esri entirely.
- `ProviderCode: 'no_route'` — the provider answered but no route exists, normalizing six
  different vendor signals (200/400/422, in-body codes, empty arrays).
- `ProviderCode: 'timeout'`, plus a default 30-second request bound.
- `polylineQuality?: 'simplified' | 'detailed'`, default `'simplified'` — ~30x smaller on
  Mapbox and OSRM with distances and durations byte-identical. No such control exists on
  HERE/TomTom/Esri.
- `trafficMode?: 'none' | 'live'` on routing and matrix, default `'none'` — see *Changed*.
- `include?: RoutingInclude[]`, default `[]`; first token `'durationWithoutTraffic'` populates
  `durationWithoutTrafficSeconds?` per leg and `totalDurationWithoutTrafficSeconds?` on the
  result. Native on Google/HERE/TomTom, never synthesized.
- `OsrmConfig.supportedExcludeClasses?` — declare what your build was compiled with to enable
  `avoidTolls`/`avoidFerries`/`avoidHighways`.

### Changed

- **Google no longer sends `routingPreference: TRAFFIC_AWARE` for a bare `departureTime`**, on
  routing and matrix. It is a Pro-tier SKU feature and matrix bills per element, so a 10x10
  request moved 100 billed elements. Now driven by `trafficMode: 'live'`.
- **TomTom now sends `traffic=false` explicitly** — its default was ON. Results change unless
  `trafficMode: 'live'` is passed.
- Mapbox and OSRM routing default to `overview=simplified` (was `full`) and no longer send
  `steps` or `annotations`.
- HERE `findsequence2` honours `avoidTolls` and takes traffic from `trafficMode`. Previously
  the optimizer ordered waypoints as if tolls were acceptable while the follow-up `/routes`
  call avoided them.

### Fixed

- `waypointOrder` could be silently corrupt on Google, TomTom, OSRM and Mapbox. All four now
  validate against the **input** waypoint count and omit the field unless it is a complete
  permutation of `[0..N-1]`.
- Geocoding no longer emits a fabricated `(0,0)` candidate or a raw `TypeError` for absent or
  non-numeric coordinates, across Google, HERE, TomTom and Esri.
- HERE `autocomplete()` with no `location` sent a request Autosuggest rejects; it now raises
  `invalid_request`, and a `_passthrough.query.at`/`.in` you supply counts as the context.
- ESRI legs now come from the stops output (`returnStops` + `Cumul_*` differences) instead of
  the superseded `directions` FeatureSet, so legs reconcile to the totals by construction.
  `raw` no longer carries `directions`, and `waypointOrder` is emitted only when optimizing.
- Mapbox `geometries` is no longer decoupled from the decoder — overriding it to `polyline`
  divided every coordinate by 10 silently. `geometries=geojson` now works.
- OSRM `baseUrl` requires an `http(s)://` scheme (previously reported as
  `provider_unavailable`, indistinguishable from an outage) and is validated at call time
  rather than construction. Path prefixes are supported.
- `no_route` now covers OSRM/Mapbox `NoRoute`/`NoTrips`/`NoSegment`, an empty `legs[]`, and
  OSRM `Ok` with an empty `routes[]`. Esri requires `unlocated` in `error.details[]` — other
  in-body 400s stay `invalid_request`.
- A BYO transport's timeout now reports `'timeout'`. Classification asked only whether the
  library's own signal fired, and an `AbortSignal.any` abort does not abort its sources.
- Per-provider `declare module` augmentations shipped as no-ops, making Mapbox's
  `sessionToken` unusable: an extensionless target does not resolve under `node16`/`nodenext`,
  and that is ignored rather than an error. `check:dist` now asserts it.

### Documentation

- Per-geocoder "Country filter" sections, and match-highlighting offsets documented on Google
  and HERE with their absence stated on Mapbox, TomTom and Esri. Not normalized: only 2 of 5
  return them and the shapes are incompatible. The offsets count **Unicode code points**, so
  `slice()` is wrong outside the BMP.
- Per-provider "Turn-by-turn instructions" sections. TBT is off by default and not normalized,
  and Google's `X-Goog-FieldMask` and HERE's `return` are **replaced** rather than merged — so
  a partial override silently zeroes every normalized distance, duration and polyline. The
  shipped Google example had exactly that bug; fixed.

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
