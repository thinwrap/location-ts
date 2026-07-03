# TomTom Connectors

TomTom Maps connectors for routing, distance matrix, geocoding, and isochrone (reachable range) via direct HTTP calls. Each operation has its own YAML frontmatter block below.

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
- Matrix Routing: https://developer.tomtom.com/routing-api/documentation/tomtom-maps/matrix-routing
- Geocoding: https://developer.tomtom.com/search-api/documentation/geocoding-service/geocode
- Reachable Range: https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-reachable-range
- Rate limits: https://developer.tomtom.com/

## Routing

---
providerId: tomtom
operation: routing
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.tomtom.com/routing/1/calculateRoute
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://developer.tomtom.com/store/maps-api
retryAfterSurfaced: true
notes_passthrough: |
  Waypoints colon-separated in URL path: `lat1,lng1:lat2,lng2:lat3,lng3`.
  Travel modes map: `driving` → `car`, `walking` → `pedestrian`,
  `cycling` → `bicycle`. Optimization via `computeBestOrder=true`. Forward
  `routeType`, `traffic`, `avoid` (array) via `_passthrough.query`.
---

### Endpoint

`GET https://api.tomtom.com/routing/1/calculateRoute/{locations}/json`

### Narrowed input augmentations

Standard `IRoutingOptions`. `optimize: true` maps to `computeBestOrder=true`.

### Error mapping

| Vendor HTTP | `providerCode` |
|---|---|
| 400 | `invalid_request` |
| 401 / 403 | `auth_failed` |
| 429 (respects `Retry-After`) | `rate_limited` |
| 5xx | `provider_unavailable` |

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw header; parsed seconds in `providerMessage`.

## Matrix

---
providerId: tomtom
operation: matrix
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.tomtom.com/routing/matrix/2
versioning:
  vendorApiVersion: v2
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://developer.tomtom.com/store/maps-api
retryAfterSurfaced: true
notes_passthrough: |
  Synchronous POST. Matrix v2 takes JSON body with origins/destinations
  arrays. Forward `routeType`, `traffic`, `departAt`, `arriveAt` via
  `_passthrough.body`.
---

### Endpoint

`POST https://api.tomtom.com/routing/matrix/2`

### Narrowed input augmentations

Standard `IMatrixOptions`. Cycling travel mode raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` if TomTom rejects the request.

## Geocoding

---
providerId: tomtom
operation: geocoding
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.tomtom.com/search/2/geocode
versioning:
  vendorApiVersion: v2
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://developer.tomtom.com/store/maps-api
retryAfterSurfaced: true
notes_passthrough: |
  Three endpoints: geocode / reverseGeocode / search (fuzzy, used for
  autocomplete). Reverse returns position as a string `"lat,lon"` which
  the connector parses. Forward `countrySet`, `language`, `limit`,
  `typeahead` via `_passthrough.query`.
---

### Endpoints

- Forward: `GET https://api.tomtom.com/search/2/geocode/{query}.json`
- Reverse: `GET https://api.tomtom.com/search/2/reverseGeocode/{lat},{lng}.json`
- Autocomplete (Fuzzy Search): `GET https://api.tomtom.com/search/2/search/{query}.json`

## Isochrone

---
providerId: tomtom
operation: isochrone
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.tomtom.com/routing/1/calculateReachableRange
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://developer.tomtom.com/store/maps-api
retryAfterSurfaced: true
notes_passthrough: |
  TomTom Reachable Range supports only ONE budget per call. Multi-value
  isochrone requests are split into parallel `Promise.all` calls — one
  per value. Forward `routeType`, `traffic`, `vehicleEngineType` via
  `_passthrough.query`.
---

### Endpoint

`GET https://api.tomtom.com/routing/1/calculateReachableRange/{lat},{lng}/json`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time'` ⇒ `timeBudgetInSec=`; `type: 'distance'` ⇒ `distanceBudgetInMeters=`. Multi-value calls fan out via parallel requests.
