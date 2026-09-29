# OSRM Connectors

[OSRM](https://project-osrm.org/) (Open Source Routing Machine) connectors for routing and distance matrix. **Self-hosted** — no API key, no managed service.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'osrm'`:

```typescript
import { Routing, Matrix } from '@thinwrap/location';

const routing = new Routing('osrm', { baseUrl: 'http://localhost:5000' });
const matrix  = new Matrix('osrm',  { baseUrl: 'http://localhost:5000' });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `baseUrl` | `string` | yes | OSRM server URL (e.g. `http://localhost:5000` or your hosted instance) |
| `supportedExcludeClasses` | `OsrmExcludeClass[]` | no | Exclude classes YOUR build was compiled with — see below |

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('osrm', config, myFetch)`). It defaults to `globalThis.fetch`.

The connector requires an explicit non-empty `baseUrl`; the operation rejects with `ConnectorError` `providerCode: 'invalid_request'` before any HTTP call when it's missing. (A missing config object is different: `new Routing('osrm', null)` throws a `TypeError` at construction, like every facade.) The public demo server is deliberately never a default.

`baseUrl` must include an **`http://` or `https://` scheme**; a bare host
(`router.example.com`) is rejected with the same typed error. Without the check it would
reach `fetch()` as a relative URL, reject with `TypeError: Invalid URL`, and surface as
`provider_unavailable` — a config typo reported as an outage.

A **path prefix is supported** — `https://maps.example.com/osrm` works, for reverse-proxied
instances — and trailing slashes are stripped, so `https://host/` and `https://host` behave
identically.

## Auth setup

**None.** OSRM is self-hosted. Front it with a reverse proxy if you need authentication or rate limiting — 401/429 responses from the proxy are surfaced as `auth_failed` / `rate_limited` ConnectorErrors.

## Vendor docs

- OSRM Route service: https://project-osrm.org/docs/v5.24.0/api/#route-service
- OSRM Trip service: https://project-osrm.org/docs/v5.24.0/api/#trip-service
- OSRM Table service: https://project-osrm.org/docs/v5.24.0/api/#table-service

## Routing

### Endpoints

- Routing: `GET {baseUrl}/route/v1/{profile}/{coordinates}`
- Optimization (TSP): `GET {baseUrl}/trip/v1/{profile}/{coordinates}`

### Narrowed input augmentations

Pre-flight validation raises typed errors before any HTTP call:

| Unsupported field | `providerCode` |
|---|---|
| `avoidTolls` (unless `toll` is declared) | `unsupported_option` |
| `avoidFerries` (unless `ferry` is declared) | `unsupported_option` |
| `avoidHighways` (unless `motorway` is declared) | `unsupported_option` |

**Traffic and departure time.** OSRM routes on the static speeds of its compiled profile
and has no time parameter. Traffic can only come from rebuilding the graph (`osrm-contract`
with edge-weight updates), not from a request option. So `trafficMode: 'traffic'` (or its
deprecated alias `'live'`) is **ignored**, and a `departureTime` is ignored with it. Under
`'none'` a departure time has no effect by definition. Neither is rejected.

### Open trips and fixed endpoints

On an open route (`roundtrip=false`) the fixed-endpoint flags are sent to the Trip service as-is:

| Flags | `source` / `destination` |
|---|---|
| `optimizeFixedOrigin` + `optimizeFixedDestination` | `first` / `last` |
| `optimizeFixedOrigin` alone | `first` / `any` |
| `optimizeFixedDestination` alone | `any` / `last` |
| plain `optimize` (neither fixed) | `first` / `last` |

OSRM supports every combination except `any/any` with `roundtrip=false` (osrm-backend `trip.cpp`, added in v5.27), so a plain `optimize` keeps the first and last waypoint in place and reorders the middle. An OSRM build older than 5.27 answers a single fixed end with `NotImplemented`, which surfaces as `unsupported_option`.

### Making the avoid-flags work: `supportedExcludeClasses`

Whether OSRM accepts `exclude=toll` is a property of **your server**, not of OSRM. The
same request was verified live against two builds with opposite results: the public demo
build rejects it with `InvalidValue`, while a self-hosted instance honoured it and
genuinely rerouted (138075 m / 5890 s via the toll road → 130421 m / 6513 s without it).

Stock OSRM compiles no exclude classes, so the flags are rejected up front by default —
better than sending a request the server will bounce with an opaque error. If your profile
was built with them, declare it:

```typescript
const routing = new Routing('osrm', {
  baseUrl: 'https://routing.internal',
  supportedExcludeClasses: ['toll', 'ferry'],
});

// Now honoured, and sent as `exclude=toll`.
await routing.route({ waypoints, avoidTolls: true });

// Still rejected with `unsupported_option` — 'motorway' was not declared.
await routing.route({ waypoints, avoidHighways: true });
```

The same declaration covers the Matrix connector: `new Matrix('osrm', { …, supportedExcludeClasses: ['toll'] })`
sends `exclude=toll` on `/table` for `avoidTolls`.

It is declared rather than probed because there is no way to ask an OSRM server what it
supports without issuing a request that fails, and the wrapper holds no state to cache
such a probe in.

If the requested `travelMode` doesn't have a compiled profile on the server, OSRM returns HTTP 400 with a profile-missing body which the connector maps to `providerCode: 'profile_not_configured'`.

### Coordinates outside your extract are snapped, not rejected

If your instance is built from a regional extract, OSRM snaps each input coordinate to the
nearest road **in that extract** — however far away it is. A request whose waypoint falls
outside the extract therefore returns **HTTP 200 with `code: "Ok"`** and a plausible-looking
route between the wrong places. There is no error and no missing field, so no wrapper-level
check can catch it.

The signal is in the raw body: each `waypoints[i].distance` is the metres from your input to
the snapped road position. Read it from `result.raw` and apply whatever threshold suits your
application:

```typescript
const raw = result.raw as { waypoints?: Array<{ distance?: number }> };
const worstSnap = Math.max(...(raw.waypoints ?? []).map((w) => w.distance ?? 0));
if (worstSnap > YOUR_THRESHOLD_METERS) {
  // treat as "no route in this coverage area"
}
```

The library deliberately does not pick a threshold: the acceptable snap distance is
application policy (a few hundred metres is normal for a rural pickup, and disqualifying for
a city address), so it stays with you rather than being guessed here.

### Retry-After

**Not surfaced.** OSRM has no documented rate-limit; any 429 surfaces from your reverse-proxy layer, and `Retry-After` (if set by the proxy) is forwarded as `cause.retryAfter` in best-effort mode.

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Ask for `steps`
and read them from `result.raw`:

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: { query: { steps: 'true' } },
});
```

Steps land at `routes[].legs[].steps[]` — or under **`trips[]`** when `optimize: true`, since
that path calls `/trip/v1`. `steps` is its own parameter, so this merges additively.

> **OSRM returns no instruction text.** A step carries `name`, `maneuver.type`,
> `maneuver.modifier`, bearings and `intersections[]` — there is no human-readable string
> anywhere in the payload. Text is generated client-side from those fields (that is what
> `osrm-text-instructions` exists for), so an OSRM navigation UI needs a rendering layer that
> the other five providers do not.

`maneuver.type` is open-ended by design: OSRM's docs state new identifiers may be introduced
without an API change, so treat an unrecognized value as a fallback rather than an error.

## Matrix

### Endpoint

`GET {baseUrl}/table/v1/{profile}/{coordinates}?annotations=duration,distance&sources={…}&destinations={…}`

### Narrowed input augmentations

Pre-flight validation (Routing's table applies, except `avoidFerries` / `avoidHighways` don't exist on `IMatrixOptions`):

| Unsupported field | `providerCode` |
|---|---|
| `avoidTolls` (without `'toll'` in `supportedExcludeClasses`) | `unsupported_option` |

`trafficMode` and `departureTime` are ignored, as on Routing.

`avoidTolls` follows the routing rule exactly: with `'toll'` declared in
`supportedExcludeClasses`, `/table` is sent `exclude=toll` (the Table service takes OSRM's
general `exclude` option); without it the flag is refused before any request.

The connector flattens OSRM's 2D arrays to `IMatrixCell[]`; a `null` cell (an unroutable
pair) is omitted.

### Error mapping

OSRM sends every non-`Ok` envelope code with a 4xx, so the body code decides — on a 4xx and
on a 2xx alike, with the routing connector's table: `NoSegment` (and `NoTable`, which the
Table service documents as "No route found") → `no_route`,
`InvalidQuery`/`InvalidOptions`/`InvalidValue` → `invalid_request`, `NotImplemented` →
`unsupported_option`. Reverse-proxy 401/403/429 and 5xx map by status. Every error carries the
HTTP status it arrived with.

### Retry-After

**Not surfaced** (same rationale as Routing).

## Replacing a default list

The Matrix connector (`/table`) sends `annotations=duration,distance`. OSRM's own default is
`duration` alone, which would leave every cell without a distance, so the connector asks for
both. It is an ordinary default, set before the `_passthrough` merge, so
`_passthrough.query.annotations` **replaces** it outright — deliberately, because a merge could
only ever add values and would leave no way to drop one.

The list is published as the frozen constant `OSRM_TABLE_ANNOTATIONS` (`['duration',
'distance']`), which the connector builds its query from, so it is always exactly what is sent.
OSRM documents only `duration` and `distance` for the Table endpoint, so there is nothing
further to append — the constant is there so the list the normalizer relies on is visible, and
to start from if you build your own.

> **Both values feed normalized outputs:** `duration` → each cell's `durationSeconds`,
> `distance` → each cell's `distanceMeters`. A replacement list without either one gets a
> response missing that matrix, and the call raises `ConnectorError` with
> `providerCode: 'unknown'` (the matrix does not match the requested dimensions) rather than
> returning zeroed cells.
