# Mapbox Connectors

Mapbox connectors for routing, distance matrix, geocoding, and isochrone via direct HTTP calls (no `@mapbox/mapbox-sdk` SDK). Each operation has its own YAML frontmatter block below.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'mapbox'`:

```typescript
import { Routing, Matrix, Geocoding, Isochrone } from '@thinwrap/location';

const routing = new Routing('mapbox',   { accessToken: process.env.MAPBOX_TOKEN! });
const matrix  = new Matrix('mapbox',    { accessToken: process.env.MAPBOX_TOKEN! });
const geo     = new Geocoding('mapbox', { accessToken: process.env.MAPBOX_TOKEN! });
const iso     = new Isochrone('mapbox', { accessToken: process.env.MAPBOX_TOKEN! });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | `string` | yes | Mapbox public or secret access token (must include `directions:read`, `matrix:read`, `geocoding:read`, `isochrone:read` scopes) |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

## Auth setup

Create a token at https://account.mapbox.com/access-tokens/. Sent as `access_token=` query param on every request. Static — no refresh.

## Vendor docs

- Directions: https://docs.mapbox.com/api/navigation/directions/
- Matrix: https://docs.mapbox.com/api/navigation/matrix/
- Geocoding v6: https://docs.mapbox.com/api/search/geocoding-v6/
- Isochrone: https://docs.mapbox.com/api/navigation/isochrone/
- Rate limits: https://docs.mapbox.com/api/overview/#rate-limits

## Routing

---
providerId: mapbox
operation: routing
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.mapbox.com/directions/v5/mapbox
versioning:
  vendorApiVersion: v5
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://docs.mapbox.com/api/overview/#rate-limits
retryAfterSurfaced: true
notes_passthrough: |
  Mapbox uses URL-path travel modes (`driving`/`walking`/`cycling`) and
  `lng,lat` coordinate order. Forward `annotations`, `overview`, `geometries`,
  `language` etc. via `_passthrough.query`. Optimized waypoints route via
  the separate Optimization API endpoint behind the same facade method.
---

### Endpoint

- Directions: `GET https://api.mapbox.com/directions/v5/mapbox/{profile}/{coordinates}`
- Optimized trips: `GET https://api.mapbox.com/optimized-trips/v1/mapbox/{profile}/{coordinates}`

### Narrowed input augmentations

Standard `IRoutingOptions`. Travel mode is encoded into the URL path. Polyline returned in standard Google precision-5 format.

### Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 | (any) | `auth_failed` |
| 403 | (any) | `auth_failed` |
| 422 | invalid coordinates | `invalid_request` |
| 429 | (respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw header; parsed seconds appear in `providerMessage`.

### `_passthrough` example

```typescript
await routing.route({
  waypoints,
  _passthrough: { query: { annotations: 'duration,distance,speed', overview: 'full' } },
});
```

## Matrix

---
providerId: mapbox
operation: matrix
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.mapbox.com/directions-matrix/v1/mapbox
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://docs.mapbox.com/api/overview/#rate-limits
retryAfterSurfaced: true
notes_passthrough: |
  Matrix returns 2D arrays which the connector flattens to `IMatrixCell[]`.
  Forward `annotations`, `sources`, `destinations` index overrides via
  `_passthrough.query`.
---

### Endpoint

`GET https://api.mapbox.com/directions-matrix/v1/mapbox/{profile}/{coordinates}`

### Error mapping

Same as routing. Retry-After surfacing identical.

## Geocoding

---
providerId: mapbox
operation: geocoding
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.mapbox.com/search/geocode/v6/forward
versioning:
  vendorApiVersion: v6
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://docs.mapbox.com/api/overview/#rate-limits
retryAfterSurfaced: true
notes_passthrough: |
  Geocoding v6 + Searchbox v1 (for autocomplete). `countryFilter` translates
  to `country=` lowercased CSV. Autocomplete generates a per-call
  `session_token` UUID; pass `_passthrough.query.session_token` to override.
  `radius` is a documented no-op on autocomplete — use
  `_passthrough.query.proximity` for proximity biasing.
---

### Endpoints

- Forward: `GET https://api.mapbox.com/search/geocode/v6/forward`
- Reverse: `GET https://api.mapbox.com/search/geocode/v6/reverse`
- Autocomplete (Searchbox): `GET https://api.mapbox.com/search/searchbox/v1/suggest`

### Narrowed input augmentations

`countryFilter` (ISO 3166-1 alpha-2) is translated to lowercased CSV `country=us,ca`. Other Geocoding/Searchbox-specific fields go via `_passthrough.query`.

## Isochrone

---
providerId: mapbox
operation: isochrone
auth:
  method: api-key-query
  tokenLifecycle: static
endpoint:
  default: https://api.mapbox.com/isochrone/v1/mapbox
versioning:
  vendorApiVersion: v1
  lastVerified: 2026-05-17
selfHostable: false
rateLimitDocsUrl: https://docs.mapbox.com/api/overview/#rate-limits
retryAfterSurfaced: true
notes_passthrough: |
  Returns a GeoJSON `FeatureCollection`. The facade surfaces the contours
  array directly. Forward `denoise`, `generalize`, `polygons` via
  `_passthrough.query`.
---

### Endpoint

`GET https://api.mapbox.com/isochrone/v1/mapbox/{profile}/{lng},{lat}`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time' | 'distance'` toggles between `contours_minutes` and `contours_meters` query params. Mapbox accepts up to 4 contour values per call.
