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

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('google', config, myFetch)`). It defaults to `globalThis.fetch`.

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

**Traffic and departure time.** For `DRIVE` and `TWO_WHEELER`, `trafficMode` selects `routingPreference`:

| `trafficMode` | `departureTime` | Body |
|---|---|---|
| unset / `'none'` | either | `routingPreference: TRAFFIC_UNAWARE`, no `departureTime` |
| `'traffic'` | not set | `routingPreference: TRAFFIC_AWARE` (Google departs now) |
| `'traffic'` | set | `routingPreference: TRAFFIC_AWARE`, `departureTime` |

`'live'` is the deprecated alias of `'traffic'`. The time is not sent under `'none'`, because Google rejects it: HTTP 400 "Timestamp cannot be set for TRAFFIC_UNAWARE routing mode." An unaware route also uses "average time-independent traffic conditions", so the time could not change it anyway. `TRAFFIC_AWARE` is a **Pro-tier SKU** feature (the base tier is Essentials), which is why traffic is never turned on by a `departureTime` alone. Walking and cycling send no `routingPreference`, since Google rejects it for those modes, and have no traffic model.

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
import { GOOGLE_ROUTES_FIELD_MASK } from '@thinwrap/location';

await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    body: { languageCode: 'fr', units: 'IMPERIAL' },
    // The mask REPLACES the connector's own — spread the default, then add yours.
    headers: {
      'X-Goog-FieldMask': [...GOOGLE_ROUTES_FIELD_MASK, 'routes.warnings'].join(','),
    },
  },
});
```

See [Replacing a default list](#replacing-a-default-list).

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Add the step
fields to the mask and read them from `result.raw`, which carries Google's response verbatim:

```typescript
import { GOOGLE_ROUTES_FIELD_MASK } from '@thinwrap/location';

const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    headers: {
      'X-Goog-FieldMask': [
        ...GOOGLE_ROUTES_FIELD_MASK,
        'routes.legs.steps.navigationInstruction',
      ].join(','),
    },
  },
});
```

Instruction text is at `routes[].legs[].steps[].navigationInstruction.instructions`; the icon
enum is at `.maneuver`.

> **The mask is replaced, not merged.** Spread `GOOGLE_ROUTES_FIELD_MASK` as above rather than
> typing the fields out: drop any of them and the matching normalized output comes back `0` or
> `''` with no error, so the failure looks like a real zero-length route. See
> [Replacing a default list](#replacing-a-default-list).

Requesting steps does not change the SKU: the Compute Routes SKU is selected by request
*features* (`TRAFFIC_AWARE`, two-wheel routing), not by requested fields. It does enlarge the
response considerably.

---

## Matrix

### Endpoint

`POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`

### Narrowed input augmentations

Standard `IMatrixOptions` (`origins`, `destinations`, `travelMode`, `departureTime`). The connector flattens the response into `IMatrixCell[]` with `originIndex` + `destinationIndex`.

`trafficMode` and `departureTime` follow the routing table: under `'none'`, `TRAFFIC_UNAWARE` is sent with no `departureTime`, and under `'traffic'`, `TRAFFIC_AWARE` is sent plus the time when one is given. Route Matrix bills **per element**, so `'traffic'` moves every origin × destination element onto the Pro SKU.

Google answers every requested pair with an element, so an empty 200 body raises `unknown`
(with the body on `cause`) rather than returning an empty matrix. An element whose `condition`
is not `ROUTE_EXISTS`, whose `status.code` is non-zero, or which carries neither field is a
failed pair: omitted from `cells[]`, kept in `raw`.

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
| `OVER_DAILY_LIMIT` | `auth_failed` — Google: the key is missing or invalid, billing is off, a self-imposed cap was hit, or the payment method expired; waiting does not fix it |
| `OVER_QUERY_LIMIT` | `rate_limited` — "over your quota" |
| `INVALID_REQUEST` | `invalid_request` |
| `UNKNOWN_ERROR` | `provider_unavailable` — "a server error. The request may succeed if you try again" |

Autocomplete and place details use Places (New), which answers with a non-2xx and a
`{ error: { status, details[] } }` envelope instead. As on routing, the
`google.rpc.ErrorInfo` reason decides first: an invalid key is HTTP 400
`INVALID_ARGUMENT` with reason `API_KEY_INVALID`, and maps to `auth_failed`, not
`invalid_request`.

**Place details for an id that no longer resolves** (HTTP 404 `NOT_FOUND` — Google's
answer for an obsolete place id) returns `candidate: null`, as does a place returned
without a `location`; `raw` carries Google's body. Places (New) answers a malformed **or a
well-formed but unknown** id with HTTP 400 `INVALID_ARGUMENT` ("The provided Place ID: …
is not valid."), which stays an `invalid_request` error — Google does not tell the two
apart.

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
| `geocode` | `components=country:XX` — **one country only** |
| `autocomplete` | `includedRegionCodes` (JSON body, up to 15) |

`geocode` with more than one `countryFilter` entry raises `unsupported_option` before any
request. The Geocoding API has no OR across countries: `components=country:US|country:CA`
applies only the first country and pads the result with unrelated matches ("Windsor" returns
only Windsor, CT; "Mississauga" returns Mississauga, ON plus a bare "United States").

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

---

## Replacing a default list

Google's field masks are mandatory, and each connector sends its own. A
`_passthrough.headers['X-Goog-FieldMask']` **replaces** that mask outright rather than merging
into it — deliberately, because a merge could only ever add fields and would leave no way to
drop one. To add a field, spread the published default and append:

```typescript
import { GOOGLE_ROUTES_FIELD_MASK } from '@thinwrap/location';

await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    headers: {
      'X-Goog-FieldMask': [...GOOGLE_ROUTES_FIELD_MASK, 'routes.travelAdvisory'].join(','),
    },
  },
});
```

The connectors build their masks from these same frozen constants, so the published list is
always exactly what is sent:

| Constant | Sent | Fields |
|---|---|---|
| `GOOGLE_ROUTES_FIELD_MASK` | always, on `route()` | `routes.legs.distanceMeters`, `routes.legs.duration`, `routes.distanceMeters`, `routes.duration`, `routes.polyline.encodedPolyline` |
| `GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC` | added when `include` has `'durationWithoutTraffic'` | `routes.legs.staticDuration`, `routes.staticDuration` |
| `GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER` | added when any of `optimize` / `optimizeFixedOrigin` / `optimizeFixedDestination` / `isRoundTrip` is set | `routes.optimizedIntermediateWaypointIndex` |
| `GOOGLE_MATRIX_FIELD_MASK` | always, on `matrix()` | `originIndex`, `destinationIndex`, `distanceMeters`, `duration`, `status`, `condition` |
| `GOOGLE_PLACE_DETAILS_FIELD_MASK` | always, on `placeDetails()` | `id`, `formattedAddress`, `location`, `viewport` |
| `GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME` | added when `include` has `'name'` (Pro SKU) | `displayName` |

When you replace a mask on a call that also triggers a conditional group, spread that group
too — `[...GOOGLE_ROUTES_FIELD_MASK, ...GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER, 'routes.travelAdvisory']`
for an optimized route.

> **Every default field feeds a normalized output, and leaving one out mostly raises nothing** —
> Google simply omits it and the output comes back empty or zero. The exceptions are noted:
>
> - Routing: `routes.legs.*` → `legs[]` (with no `routes.legs.*` field at all, Google sends no
>   legs and a multi-waypoint route raises `no_route`; leaving out only one leg field zeroes it);
>   `routes.distanceMeters` / `routes.duration` → `totalDistanceMeters` / `totalDurationSeconds`;
>   `routes.polyline.encodedPolyline` → `polyline`; the static durations →
>   `durationWithoutTrafficSeconds` / `totalDurationWithoutTrafficSeconds`;
>   `routes.optimizedIntermediateWaypointIndex` → `waypointOrder`.
> - Matrix: `originIndex` / `destinationIndex` → each cell's position (without them every
>   successful element raises `unknown`); `distanceMeters` / `duration` → the cell values;
>   `status` / `condition` → dropping failed pairs (an element carrying neither is treated as
>   failed and omitted, so leaving both out empties `cells[]`).
> - Place details: `id` → `candidate.placeId`; `formattedAddress` and `viewport` → the same-named
>   `candidate` fields; `location` → `candidate.location` (without it `candidate` is `null`
>   rather than an invented `(0,0)`); `displayName` → `name`.
>
> Adding an opt-in group's fields by passthrough alone surfaces nothing: `durationWithoutTraffic`
> and `name` are populated only when the matching `include` token is also passed.
