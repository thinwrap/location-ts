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

## Isochrone

### Endpoint

`GET https://isoline.router.hereapi.com/v8/isolines`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time' | 'distance'` maps to HERE `range[type]=time|distance`.
