# HERE Connectors

HERE Location Services connectors for routing, distance matrix, geocoding, and isochrone via direct HTTP calls. Each operation has its own YAML frontmatter block below.

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

- Routing v8: https://www.here.com/docs/bundle/routing-api-v8-api-reference/page/index.html
- Matrix Routing v8: https://www.here.com/docs/bundle/matrix-routing-api-v8-api-reference/page/index.html
- Geocoding & Search: https://www.here.com/docs/bundle/geocoding-and-search-api-v7-api-reference/page/index.html
- Isoline Routing v8: https://www.here.com/docs/bundle/isoline-routing-api-v8-api-reference/page/index.html
- Pricing & rate limits: https://www.here.com/pricing

## Routing

---
providerId: here
operation: routing
auth:
  method: api-key-query
  tokenLifecycle: static
  regionalEndpoints:
    - https://router.hereapi.com
    - https://wps.hereapi.com
endpoint:
  default: https://router.hereapi.com/v8/routes
  regional:
    - https://router.hereapi.com/v8/routes
versioning:
  vendorApiVersion: v8
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://www.here.com/pricing
retryAfterSurfaced: true
notes_passthrough: |
  HERE uses two endpoints for "routing with optimization" — `findsequence2`
  for waypoint ordering then standard v8 routing. Forward `transportMode`
  variants, `return` flags, and `spans` parameters via `_passthrough.query`.
  Polylines come back flex-polyline encoded; the connector re-encodes to
  standard precision-5.
---

### Endpoints

- Standard routing: `GET https://router.hereapi.com/v8/routes`
- Waypoint sequence: `GET https://wps.hereapi.com/v8/findsequence2`

### Narrowed input augmentations

`optimize: true` triggers the two-step `findsequence2` → `routes` flow. Travel mode maps to HERE `transportMode`. Intermediate waypoints encoded with `!passThrough=false`.

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

---
providerId: here
operation: matrix
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://matrix.router.hereapi.com/v8/matrix
versioning:
  vendorApiVersion: v8
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://www.here.com/pricing
retryAfterSurfaced: true
notes_passthrough: |
  HERE Matrix v8 is always asynchronous. The connector hides a 3-call
  submit → poll → retrieve cycle behind a single `await matrix(input)`.
  Override the wrapper-side polling deadline with
  `_passthrough.body.timeoutMs` (default 60s; not sent to HERE).
  Polling timeout raises `ConnectorError` with `providerCode:
  'matrix_polling_timeout'` and `cause: { matrixId, statusUrl }`.
---

### Endpoint

`POST https://matrix.router.hereapi.com/v8/matrix?async=true` → poll status → retrieve.

### Narrowed input augmentations

`transportMode?: 'car' | 'truck' | 'pedestrian' | 'bicycle' | 'scooter'` overrides the base `travelMode` mapping. Polling parameters surfaced via `_passthrough.body.timeoutMs`.

## Geocoding

---
providerId: here
operation: geocoding
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://geocode.search.hereapi.com/v1/geocode
versioning:
  vendorApiVersion: v7
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://www.here.com/pricing
retryAfterSurfaced: true
notes_passthrough: |
  Three distinct endpoints for forward/reverse/autocomplete. Forward
  `in=countryCode:USA,CAN`, `at=lat,lng`, `lang=`, `limit=` via
  `_passthrough.query`.
---

### Endpoints

- Forward: `GET https://geocode.search.hereapi.com/v1/geocode`
- Reverse: `GET https://revgeocode.search.hereapi.com/v1/revgeocode`
- Autocomplete: `GET https://autosuggest.search.hereapi.com/v1/autosuggest`

## Isochrone

---
providerId: here
operation: isochrone
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://isoline.router.hereapi.com/v8/isolines
versioning:
  vendorApiVersion: v8
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://www.here.com/pricing
retryAfterSurfaced: true
notes_passthrough: |
  Returns flex-polyline-encoded boundaries which the connector decodes
  and re-emits as GeoJSON Polygons. Forward `range[type]`, `transportMode`,
  `routingMode` via `_passthrough.query`.
---

### Endpoint

`GET https://isoline.router.hereapi.com/v8/isolines`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time' | 'distance'` maps to HERE `range[type]=time|distance`.
