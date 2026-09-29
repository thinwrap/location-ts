# TomTom Connectors

TomTom Maps connectors for routing, distance matrix, geocoding, and isochrone (reachable range) via direct HTTP calls.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'tomtom'`:

```typescript
import { Routing, Matrix, Geocoding, Isochrone } from '@thinwrap/location';

const routing = new Routing('tomtom',   { apiKey: process.env.TOMTOM_KEY! });
const matrix  = new Matrix('tomtom',    { apiKey: process.env.TOMTOM_KEY! });
const geo     = new Geocoding('tomtom', { apiKey: process.env.TOMTOM_KEY! });
const iso     = new Isochrone('tomtom', { apiKey: process.env.TOMTOM_KEY! });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | TomTom API key — works across Routing v1, Matrix v2, Search v2, Reachable Range v1 |

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('tomtom', config, myFetch)`). It defaults to `globalThis.fetch`.

## Auth setup

Create a key at https://developer.tomtom.com/user/me/apps. Sent as `key=` query param on every request. Static — no refresh.

## Vendor docs

- Routing: https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route
- Matrix Routing: https://developer.tomtom.com/matrix-routing-v2-api/documentation/synchronous-matrix
- Geocoding: https://developer.tomtom.com/geocoding-api/documentation/geocode
- Reachable Range: https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-reachable-range
- Rate limits: https://developer.tomtom.com/

## Routing

### Endpoint

`GET https://api.tomtom.com/routing/1/calculateRoute/{locations}/json`

### Narrowed input augmentations

Standard `IRoutingOptions`.

- **Optimization.** Any of `optimize`, `optimizeFixedOrigin` or `optimizeFixedDestination`
  maps to `computeBestOrder=true` (with more than two waypoints). TomTom always keeps **both**
  the first and the last waypoint fixed and reorders only the intermediates — it cannot free
  one end, so `optimizeFixedOrigin` / `optimizeFixedDestination` alone behave like plain
  `optimize`. `isRoundTrip` is rejected with `unsupported_option`.
- **Avoid flags.** Each flag is sent as its own repeated `avoid=` parameter
  (`avoidTolls → tollRoads`, `avoidFerries → ferries`, `avoidHighways → motorways`).
  calculateRoute rejects a comma-joined list (`avoid=tollRoads,motorways`) with
  400 `Invalid avoid value`.
- **Traffic.** `traffic` is always sent, because TomTom's own default is traffic on.
  `trafficMode: 'traffic'` (or its deprecated alias `'live'`) sends `traffic=true`. Unset or
  `'none'` sends `traffic=false`. `departureTime` is sent as `departAt` under both.
- **`'none'` is an approximation on TomTom routing.** Calculate Route has no time-independent
  mode. `departAt=any` is rejected here: live, `traffic=false` answers 400 "traffic=false not
  allowed in combination with departAt=any", and `traffic=true` is rejected the same way. So
  `traffic=false` is the closest match, and TomTom documents that it still includes historic
  traffic: "although the current traffic data is ignored during routing, the effect of historic
  traffic on effective road speeds is still incorporated". Durations under `'none'` therefore
  include TomTom's typical traffic for the departure time, or for now. For a traffic-free
  figure, request `include: ['durationWithoutTraffic']`, which reads TomTom's
  `noTrafficTravelTimeInSeconds`. The route itself is still chosen on historic speeds.

### `waypointOrder`

TomTom reports `optimizedWaypoints[]` over the INTERMEDIATE waypoints only, each entry's
`providedIndex` being 0-based across those intermediates. The connector sorts by
`optimizedIndex`, projects to absolute input indices, and brackets the result with the fixed
origin and destination to produce the canonical `waypointOrder`.

The projection is validated: `waypointOrder` is **omitted entirely** unless it is a complete
permutation of `[0..N-1]`, so it is never a permutation that silently drops or repeats a
waypoint. The rest of the result is returned as normal, and `raw` still carries the vendor's
own `optimizedWaypoints` array.

### Error mapping

| Vendor HTTP | `providerCode` |
|---|---|
| 400 | `invalid_request` |
| 401 / 403 | `auth_failed` |
| 429 (respects `Retry-After`) | `rate_limited` |
| 5xx | `provider_unavailable` |

TomTom documents 403 as an authorization failure only; its rate limit is 429.

A 200 whose route or leg `summary` lacks `lengthInMeters`/`travelTimeInSeconds`, whose route has
no legs, or whose route points lack a coordinate raises (`unknown` / `no_route`) rather than
reporting 0 m / 0 s or a `(0,0)` vertex.

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw header; parsed seconds in `providerMessage`.

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Set
`instructionsType` and read the result from `result.raw`:

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: { query: { instructionsType: 'text' } }, // 'text' | 'tagged' | 'coded'
});
```

`text` gives plain messages, `tagged` gives the same messages marked up for formatting, and
`coded` omits `message` entirely (maneuver data only). `instructionsType` is its own parameter,
so this merges additively — the connector's `routeRepresentation=polyline` is untouched.

> **TomTom's guidance is route-level, not per-leg.** Instructions land at
> `routes[].guidance.instructions[]` — one flat list for the whole route, not nested under
> `legs[]` the way Google, Mapbox and OSRM nest theirs. To attribute an instruction to a leg you
> anchor it yourself via `routeOffsetInMeters` or `pointIndex` (the index of the instruction's
> point within the route polyline).

Each instruction carries `instructionType` and `maneuver` (two separate vocabularies),
`message`, `street`, `roadNumbers`, `signpostText`, `exitNumber`, `junctionType`,
`turnAngleInDecimalDegrees` and `drivingSide`.

## Matrix

### Endpoint

- ≤ 100 cells (`origins × destinations`): synchronous `POST https://api.tomtom.com/routing/matrix/2`.
- \> 100 cells: asynchronous submit → poll → retrieve on `https://api.tomtom.com/routing/matrix/2/async` (standard limit 2500 cells), within a single `matrix()` call.

TomTom's synchronous matrix accepts at most 100 cells under any options; 200 only with `departAt=any` + historical traffic + fastest route + car/truck and no other parameters, and 2500 only on Enterprise plans. The connector therefore switches to the async endpoint above 100 cells, whatever the `trafficMode`.

### Narrowed input augmentations

Standard `IMatrixOptions`. Cycling travel mode raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` before any request (Matrix v2 has no bicycle mode).

### Traffic

`options.traffic` and `options.departAt` are always sent.

| `trafficMode` | `departureTime` | `options` |
|---|---|---|
| unset / `'none'` | either | `traffic: "historical"`, `departAt: "any"` (the time is dropped) |
| `'traffic'` | not set | `traffic: "live"`, `departAt: "now"` |
| `'traffic'` | set | `traffic: "live"`, `departAt: "<ISO>"` |

TomTom has no `none` traffic value. `historical` with `departAt: "any"` is its
time-independent average, "tailored to the use case where the time context is irrelevant".
`historical` with a real `departAt` would apply the typical traffic for that time, which
`'none'` rules out, so the caller's time is dropped. TomTom rejects `traffic: "live"` together
with `departAt: "any"`, so a traffic request without a `departureTime` departs `"now"`.
`'live'` is the deprecated alias of `'traffic'`. A `_passthrough.body.options.departAt` still
wins.

### Async polling deadline

The async path polls for up to 60 s. `_passthrough.body.timeoutMs` overrides that deadline; it
must be a finite number of milliseconds greater than 0 — a string, `NaN`, `Infinity`, zero or a
negative raises `invalid_request` before any request (on the sync path too). The key is stripped
from the request body.

### Malformed bodies

A cell without `routeSummary` is a failed pair and is omitted. A body without a `data` list, a
non-object cell, or a summary without numeric length/travel time raises `unknown` rather than
returning an empty or zero-filled matrix.

## Geocoding

### Endpoints

- Forward: `GET https://api.tomtom.com/search/2/geocode/{query}.json`
- Reverse: `GET https://api.tomtom.com/search/2/reverseGeocode/{lat},{lng}.json`
- Autocomplete (Fuzzy Search): `GET https://api.tomtom.com/search/2/search/{query}.json`
- Place details: `GET https://api.tomtom.com/search/2/place.json?entityId=`

Place by Id answers an unknown **or malformed** `entityId` with 200 `{"results": []}`; that,
or a result without a `position`, returns `candidate: null` with the body in `raw`.

### Why Fuzzy Search, and not TomTom's Autocomplete endpoint

TomTom ships a service literally named Autocomplete
(`/search/2/autocomplete/{query}.json`), and this connector deliberately does **not** use
it. That service is a query *preprocessor*: it recognizes entities inside the input and
returns `segments[]` describing them (`brand`, `category`, `plaintext`) so you can feed
them back into another search call. Its results carry no place id, no coordinates and no
formatted address, so it cannot populate `IAutocompletePrediction.description` or
`.placeId`, and the `placeId` handoff into `placeDetails()` would have nothing to pass.

Fuzzy Search with `typeahead=true` is the endpoint that returns actual place suggestions,
which is what this operation means.

### No match-highlighting offsets

Fuzzy Search returns no match offsets — no `matches`, `highlights` or equivalent. Of the
five geocoders only Google and HERE return them, so a UI that bolds the matched substring
has to match client-side.

> TomTom's *Autocomplete* service (the one above, which this connector does not use) does
> return offsets, but they index **the user's input query**
> (`segments[].matches.inputQuery[]` with `offset`/`length`) rather than the result text —
> the opposite of what highlighting a suggestion needs. Switching endpoints would not buy
> you highlighting.

### Country filter

`countryFilter` (ISO 3166-1 alpha-2) is translated to `countrySet=<comma-csv>` on
**forward geocode and autocomplete alike**.

```typescript
await geo.autocomplete({ input: 'Dizen', countryFilter: ['IL', 'PS'] });
// → ...&countrySet=IL,PS
```

## Isochrone

### Endpoint

`GET https://api.tomtom.com/routing/1/calculateReachableRange/{lat},{lng}/json`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time'` ⇒ `timeBudgetInSec=`; `type: 'distance'` ⇒ `distanceBudgetInMeters=`. Multi-value calls fan out via parallel requests.

Isochrones have no `trafficMode`, so a `departureTime` (sent as `departAt`) makes the contour traffic-aware for that time, using the traffic TomTom expects then. No `traffic` parameter is sent, so TomTom's defaults apply (`traffic=true`, `departAt=now`): without a `departureTime` the range reflects the traffic now. `_passthrough.query.traffic: 'false'` ignores current traffic, but historic traffic still applies, as on Routing.

**Driving only.** TomTom documents that "in calculateReachableRange requests, the values bicycle and pedestrian must not be used", so `travelMode: 'walking'` and `'cycling'` raise `ConnectorError` with `providerCode: 'unsupported_travel_mode'` before any request is sent (the `'cycling'` member of the TomTom input type is kept for type compatibility only). Use Mapbox, HERE or ESRI for walking isochrones.

**Contour geometry.** Reachable Range returns a single boundary per budget, so every contour is a
`Polygon` with one ring (never a `MultiPolygon`), closed and wound counter-clockwise per RFC 7946.
