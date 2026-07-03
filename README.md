# @thinwrap/location

Unified TypeScript facade for 21 location connectors across routing, matrix, geocoding, and isochrone — over 6 providers (Google, Mapbox, HERE, ESRI, TomTom, OSRM). Stateless. Zero vendor SDKs. Bring your own `fetch`.

## Install

```bash
npm install @thinwrap/location
```

Requires Node.js ≥18 (uses native `fetch`).

## End-to-end example — 2-minute time-to-first-route

```typescript
import { Routing, ConnectorError } from '@thinwrap/location';

const routing = new Routing('google', { apiKey: process.env.GOOGLE_KEY! });

try {
  const result = await routing.route({
    waypoints: [
      { lat: 40.7128, lng: -74.0060 },  // New York
      { lat: 41.4173, lng: -73.0001 },  // Bridgeport
    ],
    travelMode: 'driving',
  });
  console.log(result.totalDistanceMeters);   // → distance in meters
  console.log(result.totalDurationSeconds);  // → duration in seconds
  console.log(result.polyline);              // → Google precision-5 polyline string
} catch (e) {
  if (e instanceof ConnectorError) {
    console.error(e.providerCode, e.providerMessage);
  } else throw e;
}
```

## Switching providers

Change the provider ID and config; the input and output shape stay identical.

```typescript
const a = new Routing('google', { apiKey: process.env.GOOGLE_KEY! });
const b = new Routing('mapbox', { accessToken: process.env.MAPBOX_TOKEN! });

const sameInput = { waypoints: [origin, destination], travelMode: 'driving' as const };
const ra = await a.route(sameInput);
const rb = await b.route(sameInput);
// ra and rb share the same IRoutingResult shape:
//   { legs, totalDistanceMeters, totalDurationSeconds, polyline, waypointOrder?, raw }
```

## Bring your own `fetch`

The third constructor argument is a fetch-compatible function — useful for tracing,
mocking, retries, or routing through `undici`.

```typescript
import { Routing } from '@thinwrap/location';
import undici from 'undici';

const tracingFetch: typeof fetch = async (url, init) => {
  console.log('→', init?.method ?? 'GET', url);
  return undici.fetch(url as string, init);
};

const routing = new Routing('google', { apiKey: process.env.GOOGLE_KEY! }, tracingFetch);
```

The wrapper holds no state — no token cache, no connection pool, no retry buffer. Every
operation is a single function call from input to output with one HTTP round-trip
(except HERE Matrix v8, which transparently runs a submit → poll → retrieve cycle behind
a single `await matrix(input)`).

## Error handling

Every failure surfaces as `ConnectorError` with a typed `providerCode`. Compose your
own retry strategy from `e.providerCode` and `e.cause` (which carries the raw
`Retry-After` header where the vendor sets one).

```typescript
import { ConnectorError } from '@thinwrap/location';

try {
  await routing.route(input);
} catch (e) {
  if (e instanceof ConnectorError) {
    switch (e.providerCode) {
      case 'rate_limited':            /* respect Retry-After in e.cause     */ break;
      case 'auth_failed':             /* rotate credentials                  */ break;
      case 'invalid_request':         /* fix payload                         */ break;
      case 'invalid_recipient':       /* fix destination                     */ break;
      case 'provider_unavailable':    /* transient 5xx — your retry strategy */ break;
      case 'unsupported_field':       /* drop OSRM-incompatible field         */ break;
      case 'unsupported_option':      /* drop OSRM-incompatible option        */ break;
      case 'unsupported_travel_mode': /* fall back to a supported travel mode */ break;
      case 'profile_not_configured':  /* compile the OSRM profile             */ break;
      case 'matrix_polling_timeout':  /* resume via e.cause.matrixId          */ break;
      case 'unknown':                 /* fallback                             */ break;
    }
  } else throw e;
}
```

The wrapper performs no automatic retry. The `Retry-After` header (when present on
HTTP 429) is surfaced via `e.cause.retryAfter` (raw header string) and the parsed
seconds count is woven into `e.providerMessage` (`…; retry after N seconds`). There is
**no** structured `retryAfterSeconds` field on `ConnectorError`.

## `_passthrough` escape valve

When the normalized input doesn't expose a vendor-specific field, forward arbitrary
keys via `_passthrough`. The wrapper deep-merges `body`, shallow-merges `headers` and
`query`. Consumer values win on conflict. Keys are forwarded verbatim — no casing
transformation.

```typescript
await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    body:    { languageCode: 'fr', units: 'IMPERIAL' },
    headers: { 'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.duration' },
    query:   { region: 'us' },
  },
});
```

Each per-connector README documents its vendor-specific `_passthrough` examples.

## Polyline utilities

```typescript
import { decodePolyline, encodePolyline, decodeFlexPolyline, encodeEsriPaths } from '@thinwrap/location';

const latLngs = decodePolyline(result.polyline);   // [{ lat, lng }, …]
const re      = encodePolyline(latLngs);           // back to precision-5
const here    = decodeFlexPolyline('BFoz5...');    // HERE flex-polyline
const esri    = encodeEsriPaths([[[ -74, 40 ], [ -73.5, 40.5 ]]]);
```

All facades emit Google precision-5 encoded polyline on `result.polyline`. The four
public utilities are the only encode/decode primitives exported — locked at v1.0.

## Language constraints

- Node.js ≥18 required (uses native `fetch`).
- Node 18 and Node 20 emit an `ExperimentalWarning` on the first `fetch` call. This
  is an upstream Node disclosure, not a `@thinwrap/location` warning. Node 22+ is
  warning-free. Set `NODE_NO_WARNINGS=1` to suppress on 18/20.
- Ships dual-build: ESM (`import`) and CJS (`require`). Full TypeScript types.
- Zero runtime dependencies. No vendor SDKs.
- Server-only. Browser support is not in v1.0 — most providers require server-only
  secrets.

## Public API surface (locked at v1.0)

| Category | Exports |
|---|---|
| Facades | `Routing`, `Matrix`, `Geocoding`, `Isochrone` |
| Error | `ConnectorError`, type `ProviderCode` |
| Geometry | type `LatLng`, `encodePolyline`, `decodePolyline`, `decodeFlexPolyline`, `encodeEsriPaths`, type `EsriPathsGeometry` |
| Routing connectors | `GoogleRoutingConnector`, `MapboxRoutingConnector`, `HereRoutingConnector`, `EsriRoutingConnector`, `TomTomRoutingConnector`, `OsrmRoutingConnector` |
| Matrix connectors | `GoogleMatrixConnector`, `MapboxMatrixConnector`, `HereMatrixConnector`, `EsriMatrixConnector`, `TomTomMatrixConnector`, `OsrmMatrixConnector` |
| Geocoding connectors | `GoogleGeocodingConnector`, `MapboxGeocodingConnector`, `HereGeocodingConnector`, `EsriGeocodingConnector`, `TomTomGeocodingConnector` |
| Isochrone connectors | `MapboxIsochroneConnector`, `HereIsochroneConnector`, `EsriIsochroneConnector`, `TomTomIsochroneConnector` |
| Config types | `GoogleConfig`, `MapboxConfig`, `HereConfig`, `EsriConfig`, `TomTomConfig`, `OsrmConfig` |

## Per-connector documentation

Each per-connector README documents auth, endpoints (regional/sandbox), narrowed input
augmentations, outlier translations, error-code mappings, and `_passthrough` examples.

### Routing (6)

| Provider | README |
|---|---|
| `google` | [src/providers/google/README.md](src/providers/google/README.md) |
| `mapbox` | [src/providers/mapbox/README.md](src/providers/mapbox/README.md) |
| `here`   | [src/providers/here/README.md](src/providers/here/README.md) |
| `esri`   | [src/providers/esri/README.md](src/providers/esri/README.md) |
| `tomtom` | [src/providers/tomtom/README.md](src/providers/tomtom/README.md) |
| `osrm`   | [src/providers/osrm/README.md](src/providers/osrm/README.md) |

### Matrix (6)

| Provider | README |
|---|---|
| `google` | [src/providers/google/README.md](src/providers/google/README.md) |
| `mapbox` | [src/providers/mapbox/README.md](src/providers/mapbox/README.md) |
| `here`   | [src/providers/here/README.md](src/providers/here/README.md) |
| `esri`   | [src/providers/esri/README.md](src/providers/esri/README.md) |
| `tomtom` | [src/providers/tomtom/README.md](src/providers/tomtom/README.md) |
| `osrm`   | [src/providers/osrm/README.md](src/providers/osrm/README.md) |

### Geocoding (5)

| Provider | README |
|---|---|
| `google` | [src/providers/google/README.md](src/providers/google/README.md) |
| `mapbox` | [src/providers/mapbox/README.md](src/providers/mapbox/README.md) |
| `here`   | [src/providers/here/README.md](src/providers/here/README.md) |
| `esri`   | [src/providers/esri/README.md](src/providers/esri/README.md) |
| `tomtom` | [src/providers/tomtom/README.md](src/providers/tomtom/README.md) |

### Isochrone (4)

| Provider | README |
|---|---|
| `mapbox` | [src/providers/mapbox/README.md](src/providers/mapbox/README.md) |
| `here`   | [src/providers/here/README.md](src/providers/here/README.md) |
| `esri`   | [src/providers/esri/README.md](src/providers/esri/README.md) |
| `tomtom` | [src/providers/tomtom/README.md](src/providers/tomtom/README.md) |

## Baseline-coverage discipline

The unified facade surface includes only features ≥90% of providers natively support.
Sub-baseline fields are accessible via provider-id-narrowed augmented types and the
`_passthrough` escape hatch.

## Migrating

### From `googleapis`

```typescript
// Before — googleapis
import { google } from 'googleapis';
const routes = google.routes({ version: 'v2', auth: 'YOUR_KEY' });
const res = await routes.computeRoutes({ /* … */ });

// After
import { Routing } from '@thinwrap/location';
const routing = new Routing('google', { apiKey: 'YOUR_KEY' });
const res = await routing.route({ waypoints: [origin, destination] });
```

### From `@mapbox/mapbox-sdk-js`

```typescript
// Before — @mapbox/mapbox-sdk
import mbxClient from '@mapbox/mapbox-sdk';
import mbxDirections from '@mapbox/mapbox-sdk/services/directions';
const directions = mbxDirections(mbxClient({ accessToken }));
await directions.getDirections({ waypoints: [{ coordinates: [-74, 40] }, { coordinates: [-73, 41] }] }).send();

// After
import { Routing } from '@thinwrap/location';
const routing = new Routing('mapbox', { accessToken });
await routing.route({ waypoints: [{ lat: 40, lng: -74 }, { lat: 41, lng: -73 }] });
```

### From raw HTTP

If you've been hand-rolling vendor HTTP calls, the facade collapses the boilerplate to
one line per call. Error handling and retry composition stay yours.

## For AI agents and contributors

- [`.ai/guidelines.md`](.ai/guidelines.md) — contributor entry point: how to add a connector.
- [`.ai/ARCHITECTURE.md`](.ai/ARCHITECTURE.md) — 6 location-distinctive invariants.
- [`.ai/CONVENTIONS.md`](.ai/CONVENTIONS.md) — naming, file layout, test patterns.

## License

MIT.
