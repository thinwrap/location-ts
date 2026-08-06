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

OSRM is the only connector requiring an explicit `baseUrl` and shipping zero auth.
`OsrmRoutingConnector` / `OsrmMatrixConnector` validate `baseUrl` through the shared
`validateOsrmBaseUrl` helper at the **top of each operation method** — not in the
constructor, so a facade built at module load from environment config does not throw at
import — and raise a typed `ConnectorError` with `providerCode: 'invalid_request'` before
any HTTP call. It enforces exactly two rules — **present and non-empty**, and an
**`http://` or `https://` scheme**. Without a scheme the concatenated URL reaches `fetch()`
as a relative URL and rejects with `TypeError: Invalid URL`; `BaseConnector` then reports it
as `provider_unavailable` behind a sanitized message, making a config typo look exactly
like an outage.

A **path prefix is explicitly allowed** — reverse-proxying OSRM at `https://host/osrm` is a
normal deployment — and trailing slashes are stripped so the `${baseUrl}/route/v1/…`
concatenation cannot emit a double slash. Do not add a "no trailing path" rule: it would
reject valid self-hosts.

The Table service forces `annotations=duration,distance` post-passthrough-merge to guarantee
both fields on every cell.

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

13 values: 6 notifications-canonical + 7 location-extended.

- Canonical: `rate_limited`, `auth_failed`, `invalid_request`, `invalid_recipient`,
  `provider_unavailable`, `unknown`.
- Location-extended: `unsupported_field` (e.g. OSRM rejecting `departureTime`),
  `unsupported_option` (e.g. OSRM rejecting `avoidTolls`),
  `unsupported_travel_mode` (e.g. ESRI/TomTom Matrix rejecting cycling),
  `profile_not_configured` (OSRM missing compiled travel-mode profile),
  `matrix_polling_timeout` (HERE/TomTom Matrix exceeded 60s deadline),
  `no_route` (the provider answered but no route exists between the waypoints),
  `timeout` (the request exceeded the transport's timeout).

`no_route` exists because the vendors agree on nothing here — Google answers HTTP 200 with
the `routes` key absent, HERE 200 with `routes: []` plus a `notices[]` code, Mapbox
`code: "NoRoute"` on either 200 or 422, OSRM the same codes on a 400, TomTom a 400 with
`detailedError.code`, Esri a 200 with an in-body `error.code: 400` whose `details[]` name an
*unlocated* stop. All six were live-captured from the real APIs and are pinned as fixtures
in `src/providers/no-route.spec.ts` — change one only against a fresh live capture, never
against the vendor's documentation, which was wrong for three of the six.
Note it means "the provider could not use these coordinates", which in practice is almost
always an unsnappable waypoint: every provider tested happily routes Reykjavik→Oslo via
ferry, so "genuinely disconnected road network" is close to unreachable in the real graph.

## Per-connector locality

`mapVendorError(status, body)` is a private per-connector method. Each connector ships
its own canonical HTTP-status → `ProviderCode` mapping table (see `CONVENTIONS.md`).
Outlier translations (e.g. HERE Matrix v8 submit/poll/retrieve, TomTom Reachable Range
single-budget fan-out, ESRI HTTP-200-with-error-body inspection) live inside the
corresponding connector — never in `BaseConnector`, never as global middleware.

## The `fetchImpl` contract, and why it is enforced defensively

**A non-2xx must be RETURNED as a `Response`, never thrown.** Every connector's
`if (!response.ok) throw await this.raiseHttpError(...)` depends on it, and so does the
per-connector mapping above.

The seam is not fully under the caller's control, which is what makes this load-bearing: on
Node, `globalThis.fetch` dispatches through undici's **process-global** dispatcher, and a host
application can replace it at any time — `setGlobalDispatcher(new Agent().compose(retry(),
interceptors.responseError()))` is a normal thing for an app to do. Under `responseError()` a
non-2xx never materializes as a `Response`; `fetch` rejects with `TypeError: fetch failed`
whose `.cause` is a `ResponseError` carrying `statusCode`/`headers`/`body`. None of that is
visible from the `fetchImpl` the caller passed in.

`BaseConnector.invokeFetch` therefore **rebuilds the `Response`** from such a rejection and
returns it, rather than classifying the error itself. That choice is deliberate: classifying in
the base would move vendor error mapping out of the connector (breaking per-connector locality)
and lose `providerMessage` parsing and `Retry-After`. Rebuilding keeps all 24 connectors
unchanged. The detection is duck-typed on the error shape — never an `undici` import, since the
library has zero runtime dependencies.

The library reads `globalThis.fetch`; it never writes to it or to any other global. Inheriting
the host's proxy/TLS/DNS configuration is intended, imposing anything on the host is not.

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
