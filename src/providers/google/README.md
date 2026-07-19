# Google Maps Platform Connectors

Google Maps Platform connectors for routing, distance matrix, and geocoding via direct HTTP calls (no `googleapis` SDK).

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'google'`:

```typescript
import { Routing, Matrix, Geocoding } from '@thinwrap/location';

const routing = new Routing('google', { apiKey: process.env.GOOGLE_KEY! });
const matrix  = new Matrix('google',  { apiKey: process.env.GOOGLE_KEY! });
const geo     = new Geocoding('google', { apiKey: process.env.GOOGLE_KEY! });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | yes | Google Maps Platform API key (single key works across Routes + Geocoding + Places) |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

## Auth setup

Generate a key at https://console.cloud.google.com/google/maps-apis/credentials with the **Routes API**, **Geocoding API**, and **Places API** enabled. Sent as `X-Goog-Api-Key` header (Routes v2 / Matrix v2 / Places Autocomplete NEW) or `key=` query param (Geocoding). Static key — no refresh, no rotation.

## Vendor docs

- Routes API v2: https://developers.google.com/maps/documentation/routes
- Geocoding API: https://developers.google.com/maps/documentation/geocoding
- Places Autocomplete (NEW): https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
- Rate limits: https://developers.google.com/maps/documentation/routes/usage-and-billing

---

## Routing

### Endpoint

`POST https://routes.googleapis.com/directions/v2:computeRoutes`

### Narrowed input augmentations

The standard `IRoutingOptions` shape applies as-is: `waypoints`, `travelMode`, `optimize`, `departureTime`, `avoidTolls`, `avoidFerries`, `avoidHighways`. Provider-specific Routes v2 features (lane guidance, route modifiers) go via `_passthrough.body`.

### Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 | (any) | `auth_failed` |
| 403 | `error.status === 'QUOTA_EXCEEDED'` | `rate_limited` |
| 403 | (other) | `auth_failed` |
| 400 | `error.details[]` `ErrorInfo.reason` (e.g. `API_KEY_INVALID`) | `auth_failed` |
| 400 | (other) | `invalid_request` |
| 429 | (any; respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |
| network failure | — | `provider_unavailable` |

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw `Retry-After` header value; the parsed seconds count appears in `ConnectorError.providerMessage` as `…; retry after N seconds`.

### `_passthrough` example

```typescript
await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    body: { languageCode: 'fr', units: 'IMPERIAL' },
    headers: { 'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.duration,routes.warnings' },
  },
});
```

---

## Matrix

### Endpoint

`POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`

### Narrowed input augmentations

Standard `IMatrixOptions` (`origins`, `destinations`, `travelMode`, `departureTime`). The connector flattens the response into `IMatrixCell[]` with `originIndex` + `destinationIndex`.

### Error mapping

Same table as routing (`Routes API` shares the error surface). Retry-After surfacing identical.

### `_passthrough` example

```typescript
await matrix.matrix({
  origins, destinations,
  _passthrough: { body: { routingPreference: 'TRAFFIC_AWARE_OPTIMAL' } },
});
```

---

## Geocoding

### Endpoint

- Forward / reverse: `GET https://maps.googleapis.com/maps/api/geocode/json` (`key=` query auth)
- Autocomplete: `POST https://places.googleapis.com/v1/places:autocomplete` (Places Autocomplete NEW; `X-Goog-Api-Key` header auth + JSON body)

### Narrowed input augmentations

Standard `IGeocodeOptions` / `IReverseGeocodeOptions` / `IAutocompleteOptions`. Provider-specific Places fields (`sessiontoken`, `radius`, `strictbounds`) go via `_passthrough.query`.

### Error mapping

Google returns HTTP 200 with a `status` field on geocoding errors. The connector maps:

| Google `status` | `providerCode` |
|---|---|
| `OK` / `ZERO_RESULTS` | (no error) |
| `REQUEST_DENIED` | `auth_failed` |
| `OVER_QUERY_LIMIT` | `rate_limited` |
| `INVALID_REQUEST` | `invalid_request` |
| `UNKNOWN_ERROR` | `provider_unavailable` |

### `_passthrough` example

```typescript
await geo.geocode({
  address: '1600 Amphitheatre Parkway',
  _passthrough: { query: { region: 'us', language: 'en', components: 'country:US' } },
});
```
