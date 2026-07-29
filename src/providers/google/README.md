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

### `waypointOrder` and Google's `[-1]` answer

Google reports the optimized order as `routes.optimizedIntermediateWaypointIndex`, over the
INTERMEDIATE waypoints only. The connector projects that onto the canonical
`waypointOrder` (all input indices, in visit order, origin/destination inclusive).

Google does **not** always return real indices: when it declines to optimize it answers
`[-1]`. The connector validates the projection and **omits `waypointOrder` entirely**
unless it is a complete permutation of `[0..N-1]` — so `waypointOrder === undefined` means
"no usable ordering", never a silently corrupt one. The rest of the result (legs, totals,
polyline, `raw`) is returned as normal, and `raw` still carries the vendor's own field if
you need to inspect it.

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
    // The mask REPLACES the connector's own — re-list the fields it needs, then add yours.
    headers: {
      'X-Goog-FieldMask':
        'routes.legs.distanceMeters,routes.legs.duration,routes.distanceMeters,' +
        'routes.duration,routes.polyline.encodedPolyline,routes.warnings',
    },
  },
});
```

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Add the step
fields to the mask and read them from `result.raw`, which carries Google's response verbatim:

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    headers: {
      'X-Goog-FieldMask':
        'routes.legs.distanceMeters,routes.legs.duration,routes.distanceMeters,routes.duration,' +
        'routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction',
    },
  },
});
```

Instruction text is at `routes[].legs[].steps[].navigationInstruction.instructions`; the icon
enum is at `.maneuver`.

> **The mask is replaced, not merged.** `_passthrough.headers` overrides `X-Goog-FieldMask`
> wholesale, so the five baseline fields above have to stay. Drop
> `routes.polyline.encodedPolyline` and `polyline` comes back `''`; drop a distance or duration
> and the matching normalized field comes back `0`. Nothing raises — the connector coalesces
> absent values (`?? 0` / `?? ''`), so the failure looks like a real zero-length route.

Requesting steps does not change the SKU: the Compute Routes SKU is selected by request
*features* (`TRAFFIC_AWARE`, two-wheel routing), not by requested fields. It does enlarge the
response considerably.

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

### Country filter

`countryFilter` is ISO 3166-1 alpha-2 throughout this library, and each operation
translates it into the parameter that operation's endpoint actually takes:

| Operation | Parameter |
|---|---|
| `geocode` | `components=country:XX\|country:YY` |
| `autocomplete` | `includedRegionCodes` (JSON body) |

```typescript
await geo.autocomplete({ input: 'Dizen', countryFilter: ['IL', 'PS'] });
// → body.includedRegionCodes = ['il', 'ps']
```

Two things the translation handles for you, because both fail quietly otherwise:

- **Autocomplete takes ccTLD codes, not ISO**, and the two disagree on the United
  Kingdom — ISO `GB` is ccTLD `uk`. Passing `GB` through unchanged returns no UK
  predictions rather than an error, so the connector rewrites it.
- **Google caps the list at 15** and rejects the whole request over that. The
  connector raises `invalid_request` before the round-trip.

> **Setting a country filter also suppresses Google's *query* predictions.** It
> changes which *kinds* of suggestion come back, not only how many — a query-type
> row (a search term rather than a place) will no longer appear at all.

### Match-highlighting offsets

**Not normalized** — `IAutocompletePrediction` has no `matches` field. Only 2 of the
5 geocoders return offsets at all (Google and HERE), and they disagree on both the
encoding and which string the offsets index, so this stays vendor-native in `raw`:

```typescript
const res = await geo.autocomplete({ input: 'Dizen' });
const raw = res.raw as GooglePlacesAutocompleteNewResponse;
const m = raw.suggestions?.[0]?.placePrediction?.structuredFormat?.mainText?.matches;
// → [{ startOffset?: number, endOffset?: number }]
```

Available on `text`, `structuredFormat.mainText` and `structuredFormat.secondaryText`,
and present by default — no extra request field and no extra cost.

> **These are Unicode code-point offsets, not UTF-16 code units.** JavaScript string
> indices are UTF-16, so `text.slice(startOffset, endOffset)` mis-cuts any string
> containing an astral character — an emoji in a POI name is the common case. Use
> `[...text].slice(startOffset, endOffset).join('')` instead. Hebrew, Arabic and
> other BMP scripts are unaffected.
