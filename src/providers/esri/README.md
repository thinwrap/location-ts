---
providerId: esri
operations:
  routing:
    auth:
      method: arcgis-token
      tokenLifecycle: refreshable
    endpoint:
      default: https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve
    versioning:
      vendorApiVersion: NAServer-2024
      lastVerified: 2026-05-17
    selfHostable: true
    rateLimitDocsUrl: https://developers.arcgis.com/documentation/mapping-and-location-services/security-and-authentication/
    retryAfterSurfaced: false
    notes_passthrough: |
      Form-encoded POST (not JSON). ESRI returns kilometers and minutes which
      the connector normalizes to meters/seconds. ESRI may respond HTTP 200
      with an `error` field on validation failure — the connector inspects this.
      Forward `directionsLanguage`, `directionsStyleName`, `findBestSequence`,
      `preserveTerminalStops` via `_passthrough.body`.
  matrix:
    auth:
      method: arcgis-token
      tokenLifecycle: refreshable
    endpoint:
      default: https://logistics.arcgis.com/arcgis/rest/services/World/OriginDestinationCostMatrix/GPServer/GenerateOriginDestinationCostMatrix/submitJob
    versioning:
      vendorApiVersion: GPServer-2024
      lastVerified: 2026-05-17
    selfHostable: true
    rateLimitDocsUrl: https://developers.arcgis.com/documentation/mapping-and-location-services/security-and-authentication/
    retryAfterSurfaced: false
    notes_passthrough: |
      Form-encoded POST. ESRI OD Cost Matrix returns miles + minutes; connector
      normalizes to meters + seconds. OIDs are 1-based. Forward
      `outputType`, `cutoff`, `targetDestinationCount` via `_passthrough.body`.
  geocoding:
    auth:
      method: arcgis-token
      tokenLifecycle: refreshable
    endpoint:
      default: https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates
    versioning:
      vendorApiVersion: GeocodeServer-2024
      lastVerified: 2026-05-17
    selfHostable: true
    rateLimitDocsUrl: https://developers.arcgis.com/documentation/mapping-and-location-services/security-and-authentication/
    retryAfterSurfaced: false
    notes_passthrough: |
      Three endpoints: findAddressCandidates / reverseGeocode / suggest.
      Forward `category`, `countryCode`, `location`, `magicKey`, `outFields`
      via `_passthrough.query`.
  isochrone:
    auth:
      method: arcgis-token
      tokenLifecycle: refreshable
    endpoint:
      default: https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea
    versioning:
      vendorApiVersion: NAServer-2024
      lastVerified: 2026-05-17
    selfHostable: true
    rateLimitDocsUrl: https://developers.arcgis.com/documentation/mapping-and-location-services/security-and-authentication/
    retryAfterSurfaced: false
    notes_passthrough: |
      Form-encoded POST. Service Area expects minutes / miles; connector
      converts seconds → minutes and meters → miles on the wire. Returns
      ESRI geometry which the connector emits as GeoJSON Polygons. Forward
      `travelDirection`, `overlapPolicy`, `splitPolygonsAtBreaks` via
      `_passthrough.body`.
---

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

- Route service: https://developers.arcgis.com/rest/network/route/
- OD Cost Matrix: https://developers.arcgis.com/rest/network/od-cost-matrix/
- Geocoding service: https://developers.arcgis.com/rest/geocode/
- Service Area: https://developers.arcgis.com/rest/network/service-area/

## Routing

### Endpoint

`POST https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve` — `application/x-www-form-urlencoded`.

### Narrowed input augmentations

Standard `IRoutingOptions`. `optimize: true` maps to `findBestSequence=true`. Path geometry returned as coordinate arrays `[[[lng,lat],...]]`; encoded to standard polyline.

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

## Matrix

### Endpoint

`POST .../GenerateOriginDestinationCostMatrix/submitJob`

### Narrowed input augmentations

Standard `IMatrixOptions`. `travelMode` cycling raises `ConnectorError` with `providerCode: 'unsupported_travel_mode'` (ESRI's hosted World service doesn't ship a cycling network). Use `_passthrough.body.travelMode` JSON to pass a custom-published travel mode object for ArcGIS Enterprise deployments that provide one.

## Geocoding

### Endpoints

- Forward: `GET .../GeocodeServer/findAddressCandidates`
- Reverse: `GET .../GeocodeServer/reverseGeocode`
- Suggest: `GET .../GeocodeServer/suggest`

## Isochrone

### Endpoint

`POST .../ServiceArea_World/solveServiceArea`

### Narrowed input augmentations

Standard `IIsochroneOptions`. `type: 'time'` ⇒ `defaultBreaks` in minutes; `type: 'distance'` ⇒ `defaultBreaks` in miles. Connector handles the unit conversion both directions.
