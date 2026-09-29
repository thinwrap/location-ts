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

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('mapbox', config, myFetch)`). It defaults to `globalThis.fetch`.

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

`trafficMode: 'traffic'` (or its deprecated alias `'live'`) selects the `driving-traffic` profile on Directions, because traffic is a profile on Mapbox, not a flag. Walking and cycling have no traffic variant, so `'traffic'` is **ignored** there. The optimized-trips endpoint has no `driving-traffic` profile either, so an optimized route stays on `driving` and `'traffic'` is **ignored** there too.

`departureTime` becomes `depart_at` on Directions **only with `'traffic'`**, on `driving-traffic`. On plain `driving`, `depart_at` is not neutral: Mapbox predicts the duration "based on historical travel data" for that time, which is time-of-day traffic, and `'none'` promises time-independent durations. So under `'none'` the time is dropped and the route uses `driving` with no `depart_at`. This also loses the timed turn restrictions and conditional access restrictions that Mapbox documents as part of a time-dependent (`depart_at`) route. A `_passthrough.query.depart_at` still wins if you need them. `depart_at` is never sent on walking or cycling: Mapbox documents it for the driving profiles only.

Avoid flags become `exclude` on Directions. On `driving` all three are sent (`toll`, `ferry`, `motorway`). Walking and cycling accept only `ferry` of the three — Mapbox answers `exclude=toll` or `exclude=motorway` on those profiles with 422 `InvalidInput` — so `avoidTolls` / `avoidHighways` are not sent there: the cycling profile already avoids highways, walking follows sidewalks and trails, and tolls do not apply to either.

The optimized-trips endpoint (used when `optimize`, `optimizeFixedOrigin`, `optimizeFixedDestination` or `isRoundTrip` is set) accepts fewer inputs, and Mapbox answers any unrecognized query option with `InvalidInput`. These raise before any request:

| Input on an optimized route | `providerCode` |
|---|---|
| `avoidTolls` / `avoidFerries` / `avoidHighways` (no `exclude` on Optimization v1) | `unsupported_option` |
| `departureTime` with `trafficMode: 'traffic'` on driving (no `depart_at` on Optimization v1) | `unsupported_field` |
| `optimizeFixedOrigin` or `optimizeFixedDestination` alone without `isRoundTrip` | `unsupported_option` |

Under `'none'`, and on walking or cycling (no traffic model), an optimized route drops a `departureTime` instead: the time could not change the durations there.

Optimization v1 supports an open route (`roundtrip=false`) only as `source=first&destination=last` — "all other combinations are unsupported", and a single fixed end is answered with `NotImplemented`. Set both fixed-endpoint flags (or neither: plain `optimize` keeps the first and last waypoint in place), or set `isRoundTrip`. A round trip always starts at the first waypoint (`source=first`); `optimizeFixedDestination` on a round trip adds `destination=last`.

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
| 422 | `NoRoute` / `NoTrips` / `NoSegment` | `no_route` |
| 200 / 422 | `NotImplemented` (an optimized-trips `source`/`destination`/`roundtrip` combination forced via `_passthrough`) | `unsupported_option` |
| 422 | `ProcessingError` | `unknown` |
| 422 | `InvalidInput` or any other code | `invalid_request` |
| 429 | (respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |

A 200 whose route or leg lacks `distance`/`duration`, or whose route has no legs, raises
(`unknown` / `no_route`) rather than reporting 0 m / 0 s.

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

### Narrowed input augmentations

`trafficMode: 'traffic'` (or its deprecated alias `'live'`) selects the `driving-traffic` profile (driving only). Under `'none'`, and on walking or cycling (no traffic model), a `departureTime` is dropped because it could not change the durations. These raise before any request:

| Input | `providerCode` |
|---|---|
| `avoidTolls` (`exclude` is not a Matrix parameter) | `unsupported_option` |
| `departureTime` with `trafficMode: 'traffic'` on driving (`depart_at` is a sign-up beta on Matrix) | `unsupported_field` |

Sent anyway, either one is answered with 422 `Request too large for custom parameters` on a standard account. An account enrolled in the `depart_at` beta can still send it through `_passthrough.query`.

### Error mapping

As routing: the envelope code decides, on a 200 (Matrix documents `NoRoute` there) and on a
422 alike — `NoRoute` / `NoSegment` → `no_route`, `InvalidInput` → `invalid_request`, any
other 422 → `invalid_request`. Retry-After surfacing identical. A `null` cell (an unroutable
pair) is omitted; a matrix shorter than the request, or a non-numeric cell, raises
`unknown`.

## Geocoding

### Endpoints

- Forward: `GET https://api.mapbox.com/search/geocode/v6/forward`
- Reverse: `GET https://api.mapbox.com/search/geocode/v6/reverse`
- Autocomplete (Searchbox): `GET https://api.mapbox.com/search/searchbox/v1/suggest`
- Place details (Searchbox): `GET https://api.mapbox.com/search/searchbox/v1/retrieve/{mapbox_id}`

An id Search Box cannot resolve (HTTP 404 "No data found for requested ID"), an empty
`features`, or a feature without coordinates returns `candidate: null`, with the body in
`raw`.

### Narrowed input augmentations

Standard `IGeocodeOptions` / `IReverseGeocodeOptions`. `autocomplete()` and
`placeDetails()` add a typed `sessionToken`. Other Geocoding/Searchbox-specific fields go
via `_passthrough.query`.

### Session token

Search Box requires `session_token` on both `/suggest` and `/retrieve`, and bills per
session: the `/suggest` calls and the `/retrieve` that follows are one billable session
only when they carry the same token. Pass one UUIDv4 per user interaction to both calls:

```typescript
const sessionToken = crypto.randomUUID();          // one per user interaction
const { predictions } = await geo.autocomplete({ input: 'coff', sessionToken });
await geo.placeDetails({ placeId: predictions[0]!.placeId!, sessionToken });
```

When `sessionToken` is omitted the connector sends a fresh UUIDv4 on that call, so the
request is valid but bills as a session of its own. `_passthrough.query.session_token`, if
set, overrides both.

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

Isochrones have no `trafficMode`, so a `departureTime` (sent as `depart_at`) makes the contour traffic-aware for that time: Mapbox documents that "the isochrone contours will reflect traffic conditions at the time provided". Driving uses the `driving` profile, which without `depart_at` uses average conditions.

Mapbox takes **integer** contours in **increasing order** (1–60 minutes, 1–100000 meters), so the
connector sorts your values ascending and rounds them — seconds to the nearest whole minute,
meters to the nearest whole meter. Before any request it refuses (`invalid_request`):

- a time under 60 s — below Mapbox's 1-minute floor;
- two values that round to the same contour (e.g. 600 s and 620 s are both 10 minutes);
- a distance that rounds below 1 m.

Each returned contour's `value` is **your** value for it, not the rounded one scaled back:
90 s is sent as 2 minutes and comes back as `value: 90`.

**Contour geometry.** With `polygons=true` (always sent) each feature is a `Polygon`; a feature
whose geometry is a `MultiPolygon` is mapped too — one part stays a `Polygon`, several become a
`MultiPolygon`, so check `geometry.type` before reading `coordinates`. Holes are kept, and rings
are closed and wound per RFC 7946 (exterior counter-clockwise, holes clockwise). An unusable
part or hole is dropped.

A 200 with no features, or a feature without a numeric `contour` and a usable polygon, raises
`unknown`; a 200 `NoRoute` / `NoSegment` envelope raises `no_route`.

## Replacing a default list

The Matrix connector sends `annotations=duration,distance`. Mapbox's own default is `duration`
alone, which would leave every cell without a distance, so the connector asks for both. It is
an ordinary default, set before the `_passthrough` merge, so `_passthrough.query.annotations`
**replaces** it outright — deliberately, because a merge could only ever add values and would
leave no way to drop one.

The list is published as the frozen constant `MAPBOX_MATRIX_ANNOTATIONS` (`['duration',
'distance']`), which the connector builds its query from, so it is always exactly what is sent.
Mapbox documents only `duration` and `distance` for the Matrix endpoint, so there is nothing
further to append — the constant is there so the list the normalizer relies on is visible, and
to start from if you build your own.

> **Both values feed normalized outputs:** `duration` → each cell's `durationSeconds`,
> `distance` → each cell's `distanceMeters`. A replacement list without either one gets a
> response missing that matrix, and the call raises `ConnectorError` with
> `providerCode: 'unknown'` (the matrix does not match the requested dimensions) rather than
> returning zeroed cells.
