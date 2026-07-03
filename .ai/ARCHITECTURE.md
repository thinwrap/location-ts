# `@thinwrap/location` — Architecture

One-page summary of the facade-dispatch-base pattern and the 6 location-distinctive
invariants.

## Why facade + dispatch + base

Three layers. Consumer constructs an operation facade by provider ID; the facade
dispatches to a specific connector class; the connector extends `BaseConnector`, which
centralizes HTTP + JSON parsing + error mapping. No global middleware.

```
Consumer code
    │  new Routing('google', cfg)
    ▼
Routing facade ──── lookup ────► GoogleRoutingConnector
    │  .route(input)                 │  extends BaseConnector
    ▼                                ▼
connector.route(input)          BaseConnector.sendPostJson(url, body, opts)
                                     │
                                     ▼  fetch (BYO or globalThis.fetch)
                                Vendor API
```

## `providerId` + operation introspection

Each facade and connector exposes `providerId` (the provider-ID string literal — e.g.
`'google'`, `'mapbox'`) for runtime introspection without breaking the facade
abstraction. **Operation is implicit from the facade class** (`Routing`, `Matrix`,
`Geocoding`, `Isochrone`). Note the explicit divergence from notifications — no
`{ id, channelType }` two-axis introspection; location is single-axis.

## 6 Location-Distinctive Invariants

These are the six rules that distinguish location scope from notifications scope. They
are referenced by every per-connector README and enforced by the test suite.

### 1. `providerId`-only instance shape

Facades and connectors expose `providerId` only — no `id` + `channelType` two-tuple
(notifications scope's pattern). Operation is conveyed by the facade class itself.

### 2. NO casing-transform layer

Explicit divergence from notifications. Each connector formats request bodies in the
vendor's native casing inline; `_passthrough` keys are forwarded verbatim. There is no
`transformKeys()` helper, no `Casing.Snake`/`Casing.Camel`/`Casing.Pascal` modes.

### 3. Polyline encoding contract

All facades emit Google precision-5 encoded polyline on `result.polyline`. Four public
utilities expose the encode/decode primitives directly:

| Utility | Purpose |
|---|---|
| `encodePolyline(latLngs)` | Google precision-5 encode |
| `decodePolyline(str)` | Google precision-5 decode |
| `decodeFlexPolyline(str)` | HERE flex-polyline decode (HERE re-encodes internally) |
| `encodeEsriPaths(paths)` | ESRI coordinate-array → precision-5 (ESRI re-encodes internally) |

The public utility surface is fixed at four functions for v1.0. Adding a fifth utility requires a new minor.

### 4. OSRM self-host invariants

OSRM is the only connector requiring an explicit `baseUrl` and shipping zero auth. The
`OsrmRoutingConnector` / `OsrmMatrixConnector` constructors pre-flight-validate
`baseUrl` (`http(s)://`, no trailing path) and throw typed `ConnectorError` with
`providerCode: 'invalid_request'` before any HTTP call. The Table service forces
`annotations=duration,distance` post-passthrough-merge to guarantee both fields on
every cell.

### 5. Normalization invariants

| Field | Unit |
|---|---|
| Distance | **meters** |
| Duration | **seconds** |
| Coordinates | `LatLng = { lat, lng }` (lat-first) |
| Polyline | Google precision-5 string |

Connectors that receive vendor data in km / miles / minutes (ESRI most prominently)
convert at the wire layer before populating the result DTO.

### 6. Location-extended `ProviderCode` enum

11 values: 6 notifications-canonical + 5 location-extended.

- Canonical: `rate_limited`, `auth_failed`, `invalid_request`, `invalid_recipient`,
  `provider_unavailable`, `unknown`.
- Location-extended: `unsupported_field` (e.g. OSRM rejecting `departureTime`),
  `unsupported_option` (e.g. OSRM rejecting `avoidTolls`),
  `unsupported_travel_mode` (e.g. ESRI/TomTom Matrix rejecting cycling),
  `profile_not_configured` (OSRM missing compiled travel-mode profile),
  `matrix_polling_timeout` (HERE/TomTom Matrix exceeded 60s deadline).

## Per-connector locality

`mapVendorError(status, body)` is a private per-connector method. Each connector ships
its own canonical HTTP-status → `ProviderCode` mapping table (see `CONVENTIONS.md`).
Outlier translations (e.g. HERE Matrix v8 submit/poll/retrieve, TomTom Reachable Range
single-budget fan-out, ESRI HTTP-200-with-error-body inspection) live inside the
corresponding connector — never in `BaseConnector`, never as global middleware.

## Stateless wrapper, no retry

The wrapper holds no token cache, no connection
pool, no retry buffer. The HERE Matrix poll loop is a per-request transient — it does
not survive the `.matrix()` call. No `tokenCache` hook is needed in v1.0 because every
location auth method is static or refreshable by the consumer (ArcGIS); there is no
short-lived signed-token operation in scope.

There is **no** `retryAfterSeconds` field on `ConnectorError`. Retry-After surfaces via:
- `cause.retryAfter` — raw header string preserved on the error's `cause` object.
- `providerMessage` — parsed seconds woven into the human-readable text as
  `…; retry after N seconds`.

## Cross-reference

- Naming, file layout, test patterns: [`./CONVENTIONS.md`](./CONVENTIONS.md)
- Adding a connector / contributor entry point: [`./guidelines.md`](./guidelines.md)
- Consumer usage (install, calling the facades, error handling): [`../README.md`](../README.md)
- Per-connector frontmatter schema: [`../schemas/connector-readme-schema.yaml`](../schemas/connector-readme-schema.yaml)
