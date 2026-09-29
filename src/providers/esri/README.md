# ESRI ArcGIS Connectors

ESRI ArcGIS Location Services connectors for routing, distance matrix, geocoding, and isochrone (service areas) via direct HTTP calls.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'esri'`:

```typescript
import { Routing, Matrix, Geocoding, Isochrone } from '@thinwrap/location';

const routing = new Routing('esri',   { apiKey: process.env.ARCGIS_KEY! });
const matrix  = new Matrix('esri',    { apiKey: process.env.ARCGIS_KEY! });
const geo     = new Geocoding('esri', { apiKey: process.env.ARCGIS_KEY! });
const iso     = new Isochrone('esri', { apiKey: process.env.ARCGIS_KEY! });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | `string` | one of | Long-lived ArcGIS API key |
| `arcgisToken` | `string` | one of | Short-lived ArcGIS OAuth access token |

A custom `fetch` is not a config field: pass it as the facade's third argument (`new Routing('esri', config, myFetch)`). It defaults to `globalThis.fetch`.

## Auth setup

Create an API key at https://developers.arcgis.com/api-keys/. Sent as `token=` form field (NAServer endpoints) or query param (GeocodeServer). Token lifecycle: **refreshable** — long-lived API keys, but OAuth-issued tokens require client-side refresh.

Set exactly one of `apiKey` and `arcgisToken`. The config is a plain object, so this is checked
when an operation runs, before any request: both set rejects with `ConnectorError`
`invalid_request`, neither set with `auth_failed`.

The connectors call Esri's hosted World services (`route-api.arcgis.com`,
`geocode-api.arcgis.com`); the endpoints are fixed, and `_passthrough` cannot redirect them,
so an ArcGIS Enterprise deployment is not reachable through these connectors.

## Vendor docs

- Route service: https://developers.arcgis.com/rest/routing/route-service-direct/
- **Response fields (the one that is easy to miss):** https://doc.esri.com/en/arcgis-pro/latest/tool-reference/ready-to-use/output-findroutes.html
  — the REST page above documents **parameters only**, and its "Types" link is *input*
  data types. Every output FIELD (`Cumul_*`, `Status`, `DistanceToNetworkInMeters`,
  `DirectionPointType`) is defined here, in the ArcGIS Pro tool reference.
- OD Cost Matrix: https://developers.arcgis.com/rest/routing/travelCostMatrix-service-direct/
- Geocoding service: https://developers.arcgis.com/rest/geocode/
- Service Area: https://developers.arcgis.com/rest/routing/serviceArea-service-direct/

## Routing

### Endpoint

`POST https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve` — `application/x-www-form-urlencoded`.

### Narrowed input augmentations

Standard `IRoutingOptions`. Path geometry returned as coordinate arrays `[[[lng,lat],...]]`; encoded to standard polyline.

Any of `optimize`, `optimizeFixedOrigin` or `optimizeFixedDestination` maps to `findBestSequence=true`, and both preserve flags are always sent explicitly, because `findBestSequence` alone keeps **both** the first and the last stop in place:

| Flags | `preserveFirstStop` | `preserveLastStop` |
|---|---|---|
| plain `optimize`, or both ends fixed | `true` | `true` |
| `optimizeFixedOrigin` alone | `true` | `false` |
| `optimizeFixedDestination` alone | `false` | `true` |

`isRoundTrip` raises `unsupported_option` (`findBestSequence` has no closed-loop mode).

Avoid flags map to the restriction names `Avoid Toll Roads`, `Avoid Ferries` and `Avoid Limited Access Roads`. On driving (the service default, no travel mode sent) they go in the request-level `restrictionAttributeNames`. With `travelMode: 'walking'` they are appended to the walking travel mode's own `restrictionAttributeNames` instead: Esri takes a travel mode's restriction list wholesale and ignores the request-level parameter beside it.

**Traffic and departure time.** On Esri a start time is what turns traffic on: with a `startTime` the solve uses traffic (`now` → live traffic, a specific time → historical traffic for that time), and without one it uses "static road speeds based on average historical speeds or posted speed limits", a time-independent model. So the connector keys `startTime` off `trafficMode`:

| `trafficMode` | `departureTime` | Sent |
|---|---|---|
| unset / `'none'` | not set | nothing |
| unset / `'none'` | set | nothing (the time is dropped) |
| `'traffic'` | not set | `startTime=now`, `startTimeIsUTC=true` |
| `'traffic'` | set | `startTime=<epoch ms>`, `startTimeIsUTC=true` (the service default reads the time in the first stop's local time zone) |

`'live'` is the deprecated alias of `'traffic'` and sends the same. Dropping the time under `'none'` has two side effects. Stop `ArriveTime`/`DepartTime` come back `null` in `raw`. Time-referenced road closures are also not applied: a timed solve reports "One or more road closures were traversed." where a time-neutral one does not. This is the Esri equivalent of HERE's `traffic[mode]=disabled` closure caveat. A `_passthrough.body.startTime` is merged last and still wins. An invalid `Date` raises `invalid_request` before any request, under every `trafficMode`. Walking has no traffic, so a time changes nothing there.

The connector sends `ignoreInvalidLocations=false`. The service default (`true`) silently skips a stop it cannot locate on the network and routes through the rest; with `false` the request fails, and that in-body "unlocated" failure surfaces as `no_route`.

### Per-leg values come from the stops FeatureSet, not from directions

Legs are differences of the per-stop **cumulative** costs
(`Cumul_TravelTime` / `Cumul_Kilometers`), so the connector sends `returnStops=true` +
`accumulateAttributeNames` and `returnDirections=false`. Esri documents the
turn-by-turn output as **superseded** — *"Legacy: This output type has been superseded
by the DirectionPoints and DirectionLines output classes, which should be used for all
new scripts and workflows"* — and its `esriDMT*` maneuver values are not enumerated in
the REST reference at all.

Three consequences:

- Legs sum to the totals exactly, since both come from the same cumulative series.
- **`result.raw` contains no `directions`.** For turn-by-turn text, request it through
  `_passthrough` (`returnDirections`, `directionsOutputType`) and prefer
  `esriDOTFeatureSets`, whose `DirectionPointType` is a documented integer enum —
  Arrive (50), Depart (51), Straight (52) … — over the legacy `esriDMT*` strings.
- The cumulative field name follows the active impedance (`Cumul_TravelTime` driving,
  `Cumul_WalkTime` walking). The connector reads exactly the time attribute it requested
  for the mode plus `Cumul_Kilometers`, so extra accumulated attributes (`Miles`,
  `TruckTravelTime`, …) never change which fields feed the legs; only if you replace the
  list without them does it fall back to discovering the columns by shape. See
  [Replacing a default list](#replacing-a-default-list).

### Out-of-network coordinates: read the snap distance

Each stop in `result.raw` carries `DistanceToNetworkInMeters` — how far the coordinate was
moved to reach a routable road — plus a `Status` code (`0` OK, `1` Not Located, `5` Not
Reached, `7` Not located on closest).

A coordinate far from any road still yields a well-formed route to wherever it snapped,
so that distance is the only signal it happened. The acceptable threshold is application
policy — a few hundred metres is normal for a rural pickup and disqualifying for a city
address — so the library does not pick one. This is the Esri analogue of OSRM's
`waypoints[].distance`.

### Error mapping

| Vendor signal | `providerCode` |
|---|---|
| HTTP 200 + body `error.code === 498`/`499` | `auth_failed` |
| HTTP 200 + body `error.code === 400` with an "unlocated" stop in `details` (routing) | `no_route` |
| HTTP 200 + body `error.code === 400` | `invalid_request` |
| HTTP 401 / 403 | `auth_failed` |
| HTTP 429 | `rate_limited` |
| HTTP 5xx | `provider_unavailable` |

A 200 whose route carries neither per-stop cumulative costs nor route totals, or whose path
points lack an x/y, raises `unknown` rather than reporting 0 m / 0 s or a `(0,0)` vertex.

### Retry-After

ESRI's API tier may or may not document `Retry-After` (depends on subscription). When present on HTTP 429, surfaced via `cause.retryAfter` + `providerMessage`.

### Turn-by-turn instructions

**Not normalized** — `IRoutingResult` has no `steps` field. Unlike the other five providers this
is a *re-enable* rather than an opt-in: the service default is `returnDirections=true`, and the
connector sends `false` explicitly so the payload is not shipped on every call.

```typescript
const res = await routing.route({
  waypoints: [origin, destination],
  _passthrough: { body: { returnDirections: 'true' } },
});
```

Directions land at `raw.directions[].features[].attributes` — `text`, `maneuverType`, `length`,
`time`. `returnDirections` is its own form field, so this merges additively (values are
stringified, so `true` works as well as `'true'`).

> **Esri documents this output as superseded**, in favour of the DirectionPoints and
> DirectionLines output classes, which it recommends "for all new scripts and workflows". Its
> `esriDMT*` `maneuverType` enumeration is not published in the REST reference at all — only in
> the Runtime SDK references and legacy JS 3.x docs. Legs and totals in `IRoutingResult` come
> from the `stops` cumulative costs (`Cumul_*`) precisely so the normalized path does not depend
> on this surface.

## Matrix

### Endpoint

`POST .../OriginDestinationCostMatrix_World/solveODCostMatrix`

### Narrowed input augmentations

Standard `IMatrixOptions`. `avoidTolls` is sent as the `Avoid Toll Roads` restriction — inside the travel mode for walking, request-level for driving (see Routing). The cost columns are read by name (`TravelTime` or `WalkTime`, plus `Kilometers`); a response whose `costAttributeNames` lacks a known time column or `Kilometers`, or a cell too short for its columns, raises `unknown` with the columns in `cause.costAttributeNames` rather than reporting 0s. The straight-lines (`odLines`) fallback reads `Total_WalkTime` on a walking matrix and raises the same way when the needed total is absent; an `OriginID`/`DestinationID` that is not an integer within the requested dimensions raises `unknown`, as on the sparse path. `departureTime` and `trafficMode` follow the routing rule, using `timeOfDay`/`timeOfDayIsUTC` because `solveODCostMatrix` has no `startTime` parameter. Under `'none'` no `timeOfDay` is sent, even when a `departureTime` is given. Under `'traffic'`, `timeOfDay` is the time in epoch milliseconds with `timeOfDayIsUTC=true`, or `now` when no time is given. Esri applies live traffic for a `timeOfDay` within 4 hours of now and typical traffic beyond that. A `_passthrough.body.timeOfDay` still wins. `travelMode` cycling raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` (ESRI's hosted World service doesn't ship a cycling network). A custom travel-mode object can be sent as `_passthrough.body.travelMode` JSON.

## Geocoding

### Endpoints

- Forward: `GET .../GeocodeServer/findAddressCandidates`
- Reverse: `GET .../GeocodeServer/reverseGeocode`
- Suggest: `GET .../GeocodeServer/suggest`

**Reverse geocode with nothing nearby.** ESRI answers a location with no address in range with
an `error` body (code 400, details "Unable to find address for the specified location.")
rather than an empty result. That is "no result", so it returns `candidates: []`, the same
shape as the other four providers; any other error body still raises.

**Place details** (`findAddressCandidates?magicKey=`) returns `candidate: null` for an empty
`candidates` list or a candidate without a location. A magicKey ESRI rejects — invalid, or
generated by an earlier release of the service ("…no longer valid") — stays an
`invalid_request` error. A partial `extent` drops `viewport` rather than filling a corner
with 0.

### Country filter

`countryFilter` (ISO 3166-1 alpha-2 — ESRI uses alpha-2 directly) is translated to
`countryCode=<comma-csv>` on **forward geocode and suggest alike**.

```typescript
await geo.autocomplete({ input: 'Dizen', countryFilter: ['IL', 'PS'] });
// → ...&countryCode=IL,PS
```

### `suggest` returns the least of the five

A suggestion carries only `text` and `magicKey`. That is why ESRI is the one provider
where `structuredFormat` is always absent (there is no distinct main part to split out),
and it returns no match-highlighting offsets and no result types either — of the five
geocoders only Google and HERE return offsets. `magicKey` becomes `placeId`.

## Isochrone

### Endpoint

`POST .../ServiceArea_World/solveServiceArea`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `solveServiceArea` has no break-units parameter — `defaultBreaks` is read in the units of the impedance attribute:

- `type: 'time'` ⇒ `defaultBreaks` in minutes (input seconds ÷ 60), on the default `TravelTime` (driving) or `WalkTime` (walking) impedance.
- `type: 'distance'` ⇒ `defaultBreaks` in kilometers (input meters ÷ 1000) on a `Kilometers` impedance: `impedanceAttributeName=Kilometers` for driving; for walking, Esri's published World "Walking Distance" travel-mode object (id `yFuMFwIYblqKEefX`, `impedanceAttributeName: Kilometers`), since a travel mode overrides the request-level `impedanceAttributeName`. Each polygon is reported with **your** value for the `ToBreak` it answers — 7 s is sent as `0.116667` minutes and comes back as `value: 7`, not `7.00002`. Breaks go out in plain decimal notation. A 200 with no polygons, or a polygon without a numeric `ToBreak` or any usable ring, raises `unknown`.

**Contour geometry.** An Esri service-area polygon's `rings` can hold several exterior rings and hole rings, in no guaranteed order — `rings[0]` may be a hole. Rings are classified by winding (Esri winds exteriors clockwise, holes counter-clockwise), and each hole is attached to the smallest exterior containing its first vertex, or to the largest exterior when none does. One exterior is a `Polygon`; several (an island, a region split by water) are a `MultiPolygon` holding every part — check `geometry.type` before reading `coordinates`. Output rings are closed and re-wound per RFC 7946 (exterior counter-clockwise, holes clockwise). A zero-area ring is kept as an exterior; an empty or malformed ring is dropped; if no ring is clockwise, every ring is read as its own exterior.

`outputPolygons` is `esriNAOutputPolygonDetailed` only while every break is within ESRI's detailed-polygon limit — 15 minutes (900 s) or 15 miles (24 140 m); larger breaks request the service-default `esriNAOutputPolygonSimplified` (limit 300 minutes / 300 miles).

`departureTime` (ISO 8601) is sent as `timeOfDay` in epoch milliseconds with `timeOfDayIsUTC=true`; an unparseable value raises `invalid_request` before any request. Isochrone has no `trafficMode`, and this time is what makes a driving service area **traffic-aware**. Esri applies live traffic for a `timeOfDay` within 4 hours of now and typical traffic beyond that. Without a `departureTime` it uses time-independent speeds.

## Replacing a default list

Routing and matrix send `accumulateAttributeNames`. A
`_passthrough.body.accumulateAttributeNames` **replaces** the connector's value outright
rather than merging into it — deliberately, because a merge could only ever add attributes and
would leave no way to drop one. To add an attribute, spread the published default and append:

```typescript
import { ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING } from '@thinwrap/location';

await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    body: {
      accumulateAttributeNames: [...ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING, 'Miles'].join(','),
    },
  },
});
```

The connectors build the form value from these same frozen constants, so the published list is
always exactly what is sent:

| Constant | Sent | Attributes |
|---|---|---|
| `ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING` | `route()` with any `travelMode` except `'walking'` | `TravelTime`, `Kilometers` |
| `ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING` | `route()` with `travelMode: 'walking'` | `WalkTime`, `Kilometers` |
| `ESRI_MATRIX_ACCUMULATE_ATTRIBUTES` | `matrix()`, every travel mode | `Kilometers` |

Spread the list for the travel mode you are calling with: the time attribute must match the
travel mode's impedance, and Esri emits no cumulative field at all for a mismatched one.

> **Leaving a default attribute out of a replacement list:**
>
> - Routing, time attribute (`TravelTime` / `WalkTime`) or `Kilometers` → the per-stop
>   `Cumul_*` values are missing, so `legs[]` fall back to an even split of the route totals.
>   Esri totals only the impedance and the accumulated attributes, so without `Kilometers` (or
>   `Miles`) there is no distance total either and `totalDistanceMeters` reads `0`, with no
>   error raised.
> - Matrix, `Kilometers` → the cost columns lack `Kilometers` and the call raises `unknown`
>   (columns in `cause.costAttributeNames`) rather than reporting 0 m cells. The time column
>   comes from the impedance and needs no accumulation.

### `outFields` on geocoding

Forward geocode and `placeDetails` send `outFields=*`. That is a wildcard, so there is no list
to publish, and nothing normalized depends on it: `outFields` only fills each candidate's
`attributes` object, and the normalizer reads none of it. It reads the candidate-level
`address` (→ `formattedAddress`), `location` (→ `location`) and `extent` (→ `viewport`),
which Esri returns regardless of `outFields`. Narrowing `outFields` through
`_passthrough.query` therefore changes only what `result.raw` carries. Reverse geocode sends no
`outFields`.
