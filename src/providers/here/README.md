# HERE Connectors

HERE Location Services connectors for routing, distance matrix, geocoding, and isochrone via direct HTTP calls.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'here'`:

```typescript
import { Routing, Matrix, Geocoding, Isochrone } from '@thinwrap/location';

const routing = new Routing('here',   { apiKey: process.env.HERE_KEY! });
const matrix  = new Matrix('here',    { apiKey: process.env.HERE_KEY! });
const geo     = new Geocoding('here', { apiKey: process.env.HERE_KEY! });
const iso     = new Isochrone('here', { apiKey: process.env.HERE_KEY! });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | HERE API key (REST) — single key works across Router v8, Matrix v8, Geocode/Revgeocode/Autocomplete, Isolines v8 |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

## Auth setup

Provision a project at https://platform.here.com/ and create a REST API key. Sent as `apiKey=` query param on every request. Static — no refresh.

## Vendor docs

- Routing v8: https://docs.here.com/routing/docs/routing-v8-intro
- Matrix Routing v8: https://docs.here.com/routing/reference/postmatrix
- Geocoding & Search: https://docs.here.com/geocoding-and-search/reference/
- Isoline Routing v8: https://docs.here.com/routing/docs/isoline-v8-intro
- Pricing & rate limits: https://www.here.com/pricing

## Routing

### Endpoints

- Standard routing: `GET https://router.hereapi.com/v8/routes`
- Waypoint sequence: `GET https://wps.hereapi.com/v8/findsequence2`

### Narrowed input augmentations

`optimize: true` triggers the two-step `findsequence2` → `routes` flow. Travel mode maps to HERE `transportMode`. Intermediate waypoints are added as `via=lat,lng` query parameters.

### Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 | (any) | `auth_failed` |
| 403 | (any) | `auth_failed` |
| 400 | (any) | `invalid_request` |
| 429 | (respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw header; parsed seconds in `providerMessage`.

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Request
`actions,instructions` and read them from `result.raw`:

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: { query: { return: 'polyline,summary,actions,instructions' } },
});
```

Actions land at `routes[].sections[].actions[]`: `action` (the maneuver), `instruction`
(localized text), `offset` (an index into that section's polyline), plus `duration` and
`length`.

> **`return` is replaced, not merged.** The connector sends `polyline,summary`; keep both in
> your list or legs, totals and `polyline` all come back empty with no error raised. HERE also
> rejects `instructions` unless `actions` is requested alongside it.

For a full navigation payload HERE offers `turnByTurnActions`, which requires `polyline` in the
same `return` list.

## Matrix

### Endpoint

`POST https://matrix.router.hereapi.com/v8/matrix?async=true` → poll status → retrieve.

### Narrowed input augmentations

`transportMode?: 'car' | 'truck' | 'pedestrian' | 'bicycle' | 'scooter'` overrides the base `travelMode` mapping. Polling parameters surfaced via `_passthrough.body.timeoutMs`.

## Geocoding

### Endpoints

- Forward: `GET https://geocode.search.hereapi.com/v1/geocode`
- Reverse: `GET https://revgeocode.search.hereapi.com/v1/revgeocode`
- Autocomplete: `GET https://autosuggest.search.hereapi.com/v1/autosuggest`

### Autosuggest requires a search context

HERE documents exactly one of `at`, `in=circle` or `in=bbox` as **mandatory** on
Autosuggest, and rejects a request carrying none of them. Pass `location` (optionally
with `radius`) and the connector supplies it:

```typescript
await geo.autocomplete({ input: 'Dizen', location: { lat: 32.08, lng: 34.78 } });
```

`location` alone becomes `at=`; `location` + `radius` becomes `in=circle:…;r=…`. If you
need a bounding box instead, supply it yourself via `_passthrough.query.in` — the
connector accepts that as the context. Calling `autocomplete()` with no context at all
raises `invalid_request` locally rather than relaying a vendor 400.

### Country filter

`countryFilter` is ISO 3166-1 alpha-2 throughout this library; HERE expects **alpha-3**,
so the connector translates it. A code with no ISO alpha-3 mapping raises
`invalid_request` and points you at `_passthrough.query.in` for anything non-standard
that HERE nonetheless accepts.

```typescript
await geo.autocomplete({
  input: 'Dizen',
  location: { lat: 32.08, lng: 34.78 },
  countryFilter: ['IL', 'PS'],
});
// → ...&at=32.08,34.78&in=countryCode:ISR,PSE
```

> **HERE spells both the country filter and the spatial filter `in`.** Its docs require
> the country filter to *accompany* one of `at` / `in=circle` / `in=bbox`, so when you
> combine `countryFilter` with `radius` the connector emits `in` **twice** — once for
> the circle and once for the country codes — rather than letting one overwrite the
> other. Nothing is silently dropped, and `radius` still applies.

### Match-highlighting offsets

**Not normalized** — `IAutocompletePrediction` has no `matches` field. Only 2 of the 5
geocoders return offsets at all (HERE and Google), and they disagree on both the
encoding and which string the offsets index, so this stays vendor-native in `raw`:

```typescript
const res = await geo.autocomplete({ input: 'Dizen', location: { lat: 32.08, lng: 34.78 } });
const raw = res.raw as HereAutocompleteResponse;
const h = raw.items?.[0]?.highlights;
// → { title?: [{ start, end }], address?: { label?: [{ start, end }], city?: …, street?: … } }
```

Note the shape difference from Google, which is why neither can be normalized into one
field: HERE anchors offsets to `title` and to individual **address components**
(`label`, `city`, `street`, `houseNumber`), and names the bounds `start`/`end`. Google
anchors to its own `mainText`/`secondaryText` and names them `startOffset`/`endOffset`.

## Isochrone

### Endpoint

`GET https://isoline.router.hereapi.com/v8/isolines`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time' | 'distance'` maps to HERE `range[type]=time|distance`.
