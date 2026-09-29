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

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('here', config, myFetch)`). It defaults to `globalThis.fetch`.

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

**The sequence is optimized over the same roads the route will use.** The avoid flags reach
`findsequence2` as route features in its `mode` string, strictly avoided (`-3`) and comma-joined
in one segment after the traffic segment:

| Flag | `/v8/routes` `avoid[features]` | `findsequence2` `mode` feature |
|---|---|---|
| `avoidTolls` | `tollRoad` | `tollroad:-3` |
| `avoidHighways` | `controlledAccessHighway` | `motorway:-3` |
| `avoidFerries` | `ferry` | `boatFerry:-3,railFerry:-3` |

e.g. `mode=fastest;car;traffic:disabled;tollroad:-3,motorway:-3`.

**Legs are per waypoint, not per section.** HERE splits a route into a new section at every
waypoint *and* at every implicit change of mode, such as a ferry or car-shuttle crossing inside a
driving route. The connector therefore builds each leg from consecutive sections, closing it
after a section whose `arrival.place.waypoint` is set (HERE sets that only on `via` places) and
after the final section. A two-waypoint drive with a ferry is one leg whose distance and duration
are the sums of its car, ferry and car sections. The per-section breakdown stays in
`raw.routes[0].sections`.

`transportMode?: HereTransportMode` overrides the base `travelMode` mapping with HERE's own
vehicle classes:

| Value | `/v8/routes` | `findsequence2` (`optimize: true`) |
|---|---|---|
| `car`, `truck`, `pedestrian`, `bicycle`, `scooter`, `taxi` | yes | yes |
| `bus` | yes | yes |
| `privateBus` | yes | **no — HTTP 400** |

`bus` and `privateBus` are **not synonyms**. `bus` may drive through bus-restricted and
bus-exclusive streets; `privateBus` uses those streets only where a waypoint sits on one, which
is the private pick-up / drop-off case. HERE lists `bicycle`, `bus` and `privateBus` as Beta.

Because optimization runs through the legacy `findsequence2` endpoint, whose `mode` grammar
accepts only `car`, `truck`, `pedestrian`, `bus`, `bicycle`, `scooter` and `taxi`, combining
`privateBus` with `optimize: true` fails with `invalid_request` and the provider message
`Unknown transport mode 'privateBus'`. The connector forwards the value verbatim rather than
substituting `bus` for you — pick `bus` yourself when you need optimization.

HERE's routing enum has one further value, `networkRestrictedTruck`, which this type
deliberately omits: `findsequence2` and Matrix v8 both reject it, and `/v8/routes` returns 400
`Missing 'networkRestrictedTruck[permittedNetworks]' parameter` unless that companion parameter
is supplied, which the connector does not model. Reach it through `_passthrough.query` together
with `networkRestrictedTruck[permittedNetworks]` if you need it.

Taxi-specific tuning is likewise `_passthrough.query`; HERE's bracketed keys pass through
verbatim:

```typescript
await routing.route({
  waypoints: [origin, destination],
  transportMode: 'taxi',
  // Default is true. When true, HERE also ignores traffic on roads with taxi
  // lanes, on the assumption a taxi can bypass the congestion.
  _passthrough: { query: { 'taxi[allowDriveThroughTaxiRoads]': 'false' } },
});
```

> `_passthrough.query` is merged into **both** legs of the optimized flow. `findsequence2`
> ignores query parameters it does not recognize (verified live), so a `/v8/routes`-only key
> such as `taxi[...]` rides along harmlessly rather than failing the sequence call.

### Error mapping

| Vendor HTTP | Vendor signal | `providerCode` |
|---|---|---|
| 401 | (any) | `auth_failed` |
| 403 | (any) | `auth_failed` |
| 400 | (any) | `invalid_request` |
| 429 | (respects `Retry-After`) | `rate_limited` |
| 5xx | (any) | `provider_unavailable` |

A 200 whose route sections lack `summary.length`/`summary.duration`, or whose route has no
sections, raises (`unknown` / `no_route`) rather than summing 0 m / 0 s into a leg.

### Retry-After

On HTTP 429, `ConnectorError.cause.retryAfter` carries the raw header; parsed seconds in `providerMessage`.

### Turn-by-turn instructions

Off by default and **not normalized** — `IRoutingResult` has no `steps` field. Request
`actions,instructions` and read them from `result.raw`:

```typescript
import { HERE_ROUTING_RETURN } from '@thinwrap/location';

const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    query: { return: [...HERE_ROUTING_RETURN, 'actions', 'instructions'].join(',') },
  },
});
```

Actions land at `routes[].sections[].actions[]`: `action` (the maneuver), `instruction`
(localized text), `offset` (an index into that section's polyline), plus `duration` and
`length`.

> **`return` is replaced, not merged.** Spread `HERE_ROUTING_RETURN` as above rather than typing
> `polyline,summary` out: drop either and legs, totals and `polyline` come back empty with no
> error raised. See [Replacing a default list](#replacing-a-default-list). HERE also rejects
> `instructions` unless `actions` is requested alongside it.

For a full navigation payload HERE offers `turnByTurnActions`, which requires `polyline` in the
same `return` list.

## Matrix

### Endpoint

`POST https://matrix.router.hereapi.com/v8/matrix?async=true` → poll status → retrieve.

### Narrowed input augmentations

`transportMode?: HereTransportMode` overrides the base `travelMode` mapping. Matrix v8 publishes
the same eight values as Routing v8 — `car`, `truck`, `pedestrian`, `bicycle`, `scooter`, `taxi`,
`bus`, `privateBus` — so this is the same type the routing connector takes, with no
`findsequence2` caveat since matrix is a single call.

The poll gives up after 60 s (`matrix_polling_timeout`, with `cause.matrixId`).
`_passthrough.body.timeoutMs` overrides that deadline; it must be a finite number of
milliseconds greater than 0 — a string, `NaN`, `Infinity`, zero or a negative raises
`invalid_request` before the submit. The key is stripped from the request body.

A usable cell (error code 0 or 3) must carry both a travel time and a distance; a `null`
there, or arrays shorter than the requested grid, raise `unknown` rather than a 0 m / 0 s
cell.

## Traffic and billing

Routing and Matrix compute against **no traffic** unless you pass `trafficMode: 'traffic'`
(`'live'` is its deprecated alias and behaves identically).
HERE's own default is the opposite: a request without `departureTime` is computed for "now"
with live traffic. HERE's price list bills such a routing request as **Time-Aware Routing**
(fewer free requests and a higher per-1k rate, see
[HERE pricing](https://www.here.com/get-started/pricing)) rather than basic Car/Bicycle/Pedestrian
routing, unless the request carries `departureTime=any` or `traffic[mode]=disabled`. Matrix is
one rate either way, but its durations would otherwise include live traffic, which
contradicts the `trafficMode: 'none'` default.

What the connectors send:

| `trafficMode` | `departureTime` | `/v8/routes` query | `/v8/matrix` body |
|---|---|---|---|
| unset / `'none'` | not set | `departureTime=any` | `"departureTime": "any"` |
| unset / `'none'` | set | `departureTime=<ISO>&traffic[mode]=disabled` | `"departureTime": "<ISO>", "traffic": { "mode": "disabled" }` |
| `'traffic'` | not set | nothing (HERE's live default) | nothing (HERE's live default) |
| `'traffic'` | set | `departureTime=<ISO>` | `"departureTime": "<ISO>"` |

The follow-up `/v8/routes` call of the `optimize: true` flow gets the same parameters;
`findsequence2` carries traffic in its `mode` string instead (`traffic:disabled` unless
`'traffic'`), plus the time as `departure` when one is given.

An `arrivalTime`, or a `departureTime` other than `any`, set through `_passthrough` (routing
`query`, matrix `body`) also counts as a time, so the connector sends `traffic[mode]=disabled` (matrix
`"traffic": { "mode": "disabled" }`) instead of `departureTime=any`, which HERE rejects
alongside `arrivalTime` with HTTP 400.

> **Closures with a departure time.** `departureTime=any` ignores dynamic traffic but still
> applies long-term closures. `traffic[mode]=disabled` ignores **all** traffic data, long-term
> closures included. So with `trafficMode` left at `'none'` and a `departureTime` set, a road
> under a long-term closure can still be routed over. Pass `trafficMode: 'traffic'` if closures
> matter more than the Time-Aware rate.

**Opting back in:** pass `trafficMode: 'traffic'`. These parameters are defaults set before
`_passthrough` is merged, so a passthrough value also wins — `_passthrough.query` of
`{ 'traffic[mode]': 'default' }` on routing, or `_passthrough.body` of
`{ traffic: { mode: 'default' } }` on matrix, re-enables HERE's traffic handling for that call
(and, on routing, its Time-Aware billing).

## Geocoding

### Endpoints

- Forward: `GET https://geocode.search.hereapi.com/v1/geocode`
- Reverse: `GET https://revgeocode.search.hereapi.com/v1/revgeocode`
- Autocomplete: `GET https://autosuggest.search.hereapi.com/v1/autosuggest`
- Place details: `GET https://lookup.search.hereapi.com/v1/lookup`

An id HERE cannot resolve (HTTP 404 "Unknown Location ID") or a result without a
`position` returns `candidate: null`, with HERE's body in `raw`. A malformed id is a
400 ("Illegal input for parameter 'id'") and stays an `invalid_request` error.

### `formattedAddress` is `address.label`

For a POI, HERE's `title` is the place's **name** ("Empire State Building") and
`address.label` is its address ("Empire State Building, 20 W 34th St, New York, NY 10118,
United States"). `formattedAddress` is therefore `address.label` on geocode, reverse geocode
and place details, falling back to `title` only when a result carries no label. On place
details the `title` is surfaced as `name` (with `include: ['name']`).

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
`range[values]` is sent in plain decimal notation, never exponent form.

`travelMode` is `'driving'` (`car`) or `'walking'` (`pedestrian`). A `'cycling'` that reaches
the connector anyway (it is not in HERE's input type) raises `ConnectorError` with
`providerCode: 'unsupported_travel_mode'` before any request, like Esri, rather than silently
computing a car isoline. HERE's own `bicycle` isoline mode is Beta; send
`_passthrough.query.transportMode: 'bicycle'` to use it.

Isochrones have no `trafficMode`, so a `departureTime` makes the contour traffic-aware for that
time, as HERE documents that a concrete departure time "take[s] traffic flow and other
time-dependent effects into account". HERE's isoline docs do not say what an omitted time means
(on Routing v8 it is the request time, with live traffic). Pass
`_passthrough.query.departureTime: 'any'` for an isoline without traffic flow.

### Contour geometry

HERE types each isoline's `polygons` as a MultiPolygon: one `{ outer, inner[] }` entry per
disconnected part (parts reachable only by ferry are joined under `connections`, which stays in
`raw`). Every part is decoded, holes (`inner`) included. An isoline with one part is a
`Polygon`; with several, a `MultiPolygon` holding all of them — check `geometry.type` before
reading `coordinates`. Rings are closed and wound per RFC 7946 (exterior counter-clockwise,
holes clockwise).

A part with a missing or undecodable `outer` is dropped, as is an undecodable `inner` ring. A
200 with no isolines, or an isoline without a numeric `range.value` or any usable outer ring,
raises `unknown` rather than returning an empty `[[]]` polygon.

## Replacing a default list

The routing connector sends `return=polyline,summary` on `/v8/routes`. A
`_passthrough.query.return` **replaces** that list outright rather than merging into it —
deliberately, because a merge could only ever add values and would leave no way to drop one. To
add a value, spread the published default and append:

```typescript
import { HERE_ROUTING_RETURN } from '@thinwrap/location';

await routing.route({
  waypoints: [origin, destination],
  _passthrough: { query: { return: [...HERE_ROUTING_RETURN, 'turnByTurnActions'].join(',') } },
});
```

`HERE_ROUTING_RETURN` (`['polyline', 'summary']`) is the frozen constant the connector builds
its `return` from, so it is always exactly what is sent. There is no conditional part: opting
into `durationWithoutTraffic` reads `baseDuration` from the `summary` already requested.

> **Both default values feed normalized outputs, and leaving one out raises nothing:**
>
> - `polyline` → `polyline` (comes back `''`).
> - `summary` → `legs[]`, `totalDistanceMeters`, `totalDurationSeconds` (all `0`) and
>   `durationWithoutTrafficSeconds` / `totalDurationWithoutTrafficSeconds` (absent).

### Matrix `matrixAttributes`

The Matrix connector submits `matrixAttributes: ['travelTimes', 'distances']`, published as the
frozen constant `HERE_MATRIX_ATTRIBUTES`. `_passthrough.body` is deep-merged, but arrays are
replaced whole, so a `_passthrough.body.matrixAttributes` **replaces** the list; spread the
constant to add to it:

```typescript
import { HERE_MATRIX_ATTRIBUTES } from '@thinwrap/location';

await matrix.matrix({
  origins, destinations,
  _passthrough: { body: { matrixAttributes: [...HERE_MATRIX_ATTRIBUTES, /* another attribute */] } },
});
```

> **Both default values feed normalized outputs:** `travelTimes` → each cell's
> `durationSeconds`, `distances` → each cell's `distanceMeters`. A replacement list without
> either one gets a result missing that array, and the call raises `ConnectorError` with
> `providerCode: 'unknown'` (arrays too short for the requested dimensions) rather than
> returning zeroed cells.
