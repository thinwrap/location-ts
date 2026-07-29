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
| `apiKey` | `string` | yes | ArcGIS API key (long-lived) or an OAuth-issued access token |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

## Auth setup

Create an API key at https://developers.arcgis.com/api-keys/. Sent as `token=` form field (NAServer endpoints) or query param (GeocodeServer). Token lifecycle: **refreshable** — long-lived API keys, but OAuth-issued tokens require client-side refresh.

ArcGIS Enterprise on-prem deployments are supported by overriding endpoints in `_passthrough.headers`/`query` — point at your tenant's portal URL.

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

Standard `IRoutingOptions`. `optimize: true` maps to `findBestSequence=true`. Path geometry returned as coordinate arrays `[[[lng,lat],...]]`; encoded to standard polyline.

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
  `Cumul_WalkTime` walking). The connector discovers the key; this only matters if you
  read `result.raw` yourself.

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
| HTTP 200 + body `error.code === 400` | `invalid_request` |
| HTTP 401 / 403 | `auth_failed` |
| HTTP 429 | `rate_limited` |
| HTTP 5xx | `provider_unavailable` |

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

Standard `IMatrixOptions`. `travelMode` cycling raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` (ESRI's hosted World service doesn't ship a cycling network). Use `_passthrough.body.travelMode` JSON to pass a custom-published travel mode object for ArcGIS Enterprise deployments that provide one.

## Geocoding

### Endpoints

- Forward: `GET .../GeocodeServer/findAddressCandidates`
- Reverse: `GET .../GeocodeServer/reverseGeocode`
- Suggest: `GET .../GeocodeServer/suggest`

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

Standard `IIsochroneOptions`. `type: 'time'` ⇒ `defaultBreaks` in minutes (`esriDriveTimeUnitsMinutes`; input seconds ÷ 60); `type: 'distance'` ⇒ `defaultBreaks` in meters (`esriDriveDistanceUnitsMeters`, passed through).
