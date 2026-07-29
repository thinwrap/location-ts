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
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

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

Standard `IRoutingOptions`. `optimize: true` maps to `computeBestOrder=true`.

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

`POST https://api.tomtom.com/routing/matrix/2`

### Narrowed input augmentations

Standard `IMatrixOptions`. Cycling travel mode raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` if TomTom rejects the request.

## Geocoding

### Endpoints

- Forward: `GET https://api.tomtom.com/search/2/geocode/{query}.json`
- Reverse: `GET https://api.tomtom.com/search/2/reverseGeocode/{lat},{lng}.json`
- Autocomplete (Fuzzy Search): `GET https://api.tomtom.com/search/2/search/{query}.json`

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
