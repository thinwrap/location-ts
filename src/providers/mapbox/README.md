# Mapbox Connectors

Mapbox connectors for routing, distance matrix, geocoding, and isochrone via direct HTTP calls (no `@mapbox/mapbox-sdk` SDK).

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
- Geocoding v6: https://docs.mapbox.com/api/search/geocoding/
- Isochrone: https://docs.mapbox.com/api/navigation/isochrone/
- Rate limits: https://docs.mapbox.com/api/overview/#rate-limits

## Routing

### Endpoint

- Directions: `GET https://api.mapbox.com/directions/v5/mapbox/{profile}/{coordinates}`
- Optimized trips: `GET https://api.mapbox.com/optimized-trips/v1/mapbox/{profile}/{coordinates}`

### Narrowed input augmentations

Standard `IRoutingOptions`. Travel mode is encoded into the URL path. Polyline returned in standard Google precision-5 format.

### Overriding `geometries` via `_passthrough`

The connector requests `geometries=polyline6` and re-encodes to precision-5. If you
override `geometries` through `_passthrough.query`, the decoder **follows your value**:

| `geometries` | Handling |
|---|---|
| `polyline6` (default) | decoded at precision 6, re-encoded at precision 5 |
| `polyline` | already precision-5 — emitted verbatim |
| `geojson` | `[lng, lat]` pairs encoded at precision 5 |

This matters because the two encodings are indistinguishable as strings: decoding a
precision-5 polyline with a precision-6 decoder divides every coordinate by 10, which
lands your route in the wrong hemisphere with no error raised. An unparseable geometry
yields an empty `polyline` rather than throwing — the leg distances and durations are
still valid.

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

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Ask for `steps`
and read them from `result.raw`:

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: { query: { steps: 'true' } },
});
```

Instruction text is at `routes[].legs[].steps[].maneuver.instruction`, alongside `type`,
`modifier`, `bearing_before` / `bearing_after` and `location`. With `optimize: true` the
connector calls `/optimized-trips/v1`, which returns the same objects under **`trips[]`** rather
than `routes[]`.

`steps` is its own parameter, so this merges additively — nothing the connector sends is
displaced. `banner_instructions` and `voice_instructions` (SSML) are separate opt-ins, and both
require `steps=true`.

Steps are the single largest part of a Mapbox routing response, which is why the connector does
not request them by default.

## Matrix

### Endpoint

`GET https://api.mapbox.com/directions-matrix/v1/mapbox/{profile}/{coordinates}`

### Error mapping

Same as routing. Retry-After surfacing identical.

## Geocoding

### Endpoints

- Forward: `GET https://api.mapbox.com/search/geocode/v6/forward`
- Reverse: `GET https://api.mapbox.com/search/geocode/v6/reverse`
- Autocomplete (Searchbox): `GET https://api.mapbox.com/search/searchbox/v1/suggest`

### Narrowed input augmentations

Standard `IGeocodeOptions` / `IReverseGeocodeOptions` / `IAutocompleteOptions`. Other
Geocoding/Searchbox-specific fields go via `_passthrough.query`.

### Country filter

`countryFilter` (ISO 3166-1 alpha-2) is translated to lowercased CSV `country=us,ca` on
**forward geocode and autocomplete alike**.

```typescript
await geo.autocomplete({ input: 'coffee', countryFilter: ['IL', 'PS'] });
// → ...&country=il,ps
```

### No match-highlighting offsets

Search Box `/suggest` returns no match offsets — no `matches`, `highlights` or
equivalent. Of the five geocoders only Google and HERE return them, so a UI that bolds
the matched substring cannot get those offsets from Mapbox; it has to match client-side
against `description` / `structuredFormat`.

## Isochrone

### Endpoint

`GET https://api.mapbox.com/isochrone/v1/mapbox/{profile}/{lng},{lat}`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time' | 'distance'` toggles between `contours_minutes` and `contours_meters` query params. Mapbox accepts up to 4 contour values per call.
