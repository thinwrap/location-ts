# OSRM Connectors

[OSRM](https://project-osrm.org/) (Open Source Routing Machine) connectors for routing and distance matrix. **Self-hosted** — no API key, no managed service.

## Quick install

See the [package README](../../../README.md) for installation. Dispatches when `providerId === 'osrm'`:

```typescript
import { Routing, Matrix } from '@thinwrap/location';

const routing = new Routing('osrm', { baseUrl: 'http://localhost:5000' });
const matrix  = new Matrix('osrm',  { baseUrl: 'http://localhost:5000' });
```

## Configuration

| Field | Type | Required | Notes |
|---|---|---|---|
| `baseUrl` | `string` | yes | OSRM server URL (e.g. `http://localhost:5000` or your hosted instance) |
| `fetch` | `typeof fetch` | no | BYO fetch (defaults to `globalThis.fetch`) |

The connector requires an explicit non-empty `baseUrl` and throws `ConnectorError` with `providerCode: 'invalid_request'` before any HTTP call when it's missing.

## Auth setup

**None.** OSRM is self-hosted. Front it with a reverse proxy if you need authentication or rate limiting — 401/429 responses from the proxy are surfaced as `auth_failed` / `rate_limited` ConnectorErrors.

## Vendor docs

- OSRM Route service: https://project-osrm.org/docs/v5.24.0/api/#route-service
- OSRM Trip service: https://project-osrm.org/docs/v5.24.0/api/#trip-service
- OSRM Table service: https://project-osrm.org/docs/v5.24.0/api/#table-service

## Routing

### Endpoints

- Routing: `GET {baseUrl}/route/v1/{profile}/{coordinates}`
- Optimization (TSP): `GET {baseUrl}/trip/v1/{profile}/{coordinates}`

### Narrowed input augmentations

Pre-flight validation raises typed errors before any HTTP call:

| Unsupported field | `providerCode` |
|---|---|
| `departureTime` (no live-traffic on stock OSRM) | `unsupported_field` |
| `avoidTolls` | `unsupported_option` |
| `avoidFerries` | `unsupported_option` |
| `avoidHighways` | `unsupported_option` |

If the requested `travelMode` doesn't have a compiled profile on the server, OSRM returns HTTP 400 with a profile-missing body which the connector maps to `providerCode: 'profile_not_configured'`.

### Retry-After

**Not surfaced.** OSRM has no documented rate-limit; any 429 surfaces from your reverse-proxy layer, and `Retry-After` (if set by the proxy) is forwarded as `cause.retryAfter` in best-effort mode.

## Matrix

### Endpoint

`GET {baseUrl}/table/v1/{profile}/{coordinates}?annotations=duration,distance&sources={…}&destinations={…}`

### Narrowed input augmentations

Pre-flight validation (Routing's table applies, except `avoidFerries` / `avoidHighways` don't exist on `IMatrixOptions`):

| Unsupported field | `providerCode` |
|---|---|
| `departureTime` | `unsupported_field` |
| `avoidTolls` | `unsupported_option` |

The connector flattens OSRM's 2D arrays to `IMatrixCell[]`.

### Retry-After

**Not surfaced** (same rationale as Routing).
