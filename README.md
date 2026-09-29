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

// Construction errors (unknown provider, missing config) are bugs, thrown as TypeError.
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

## Routing options that cost money

Three inputs exist because the cheap thing and the correct thing are not always the same
request. All three default to the lean option; you opt up explicitly.

| Option | Default | What it changes |
|---|---|---|
| `polylineQuality` | `'simplified'` | Geometry fidelity. `'detailed'` returned a **30x larger** polyline on Mapbox and **31x** on OSRM in measurement, with identical distances and durations. Honoured by Google/Mapbox/OSRM; silently ignored by HERE/TomTom/Esri, which expose no equivalent knob. |
| `trafficMode` | `'none'` | Whether durations reflect traffic. `'traffic'` selects a **Pro-tier SKU** on Google and **Time-Aware Routing** billing on HERE, so it is never enabled implicitly — not even by passing `departureTime`. Applies to routing and matrix; see [Traffic and departure time](#traffic-and-departure-time). |
| `include` | `[]` | Which optional output fields to fetch. Each token maps 1:1 onto one optional result field. |

```typescript
const result = await routing.route({
  waypoints,
  trafficMode: 'traffic',                     // opt into traffic-aware routing
  polylineQuality: 'detailed',                // opt into full geometry
  include: ['durationWithoutTraffic'],        // opt into the extra output field
});

// Present only when requested AND returned natively — never synthesized, so its
// absence tells you this provider did not supply it.
const congestion =
  result.totalDurationWithoutTrafficSeconds !== undefined
    ? result.totalDurationSeconds - result.totalDurationWithoutTrafficSeconds
    : undefined;
```

`durationWithoutTraffic` is native on Google (`staticDuration`), HERE (`baseDuration`) and
TomTom (`noTrafficTravelTimeInSeconds`); Mapbox, OSRM and Esri do not return it, so the
field stays absent there rather than being faked.

### Traffic and departure time

`trafficMode` (routing and matrix) takes two values:

- `'none'` (default): no time-of-day traffic. Durations come from the provider's
  time-independent speed model. A `departureTime` never adds traffic here; where the provider
  would read the time as a traffic input, the connector drops the time or disables traffic.
  Each provider has its own static model (free-flow on HERE and OSRM, a time-independent
  historical average on Google, Esri and Mapbox), so `'none'` durations still differ between
  providers.
- `'traffic'`: the traffic expected at `departureTime`. That is live conditions close to now
  and typical or predicted conditions for later times. With no `departureTime`, it uses the
  traffic now.

`'live'` is a **deprecated** alias of `'traffic'` and behaves identically. It stays accepted,
but new code should use `'traffic'`.

| Provider | `'none'` | `'traffic'` |
|---|---|---|
| Google (routes, matrix) | exact: `TRAFFIC_UNAWARE`, the time is not sent (Google rejects a time on an unaware request) | exact: `TRAFFIC_AWARE` + the time. **Pro SKU** |
| HERE (routes, matrix, optimize) | exact: `departureTime=any`, or `traffic[mode]=disabled` when a time is given | exact: HERE's default + the time. **Time-Aware Routing SKU** on routing |
| Esri (routing, matrix) | exact: the time is not sent | exact: the time, or `now` |
| Mapbox Directions | exact: `driving`, the time is dropped | exact: `driving-traffic` + `depart_at` |
| Mapbox Matrix | exact: `driving`, the time is dropped | `driving-traffic`; with a time on driving → `unsupported_field` (Matrix `depart_at` is a sign-up beta) |
| Mapbox Optimization (`optimize`) | exact: the time is dropped | **ignored**: no traffic profile exists; with a time on driving → `unsupported_field` |
| TomTom routing | **approximate**: `traffic=false`. TomTom has no time-independent routing mode, so its typical (historic) traffic for the departure time, or for now, is still included | exact: `traffic=true` + `departAt` |
| TomTom matrix | exact: `historical` + `departAt: any`, the time is dropped | exact: `live` + the time, or `now` |
| OSRM | exact: static profile speeds; a time has no effect | **ignored**: OSRM has no request-time traffic |

Walking and cycling have no traffic model on any provider, so `'traffic'` does not change them
(on Mapbox Matrix and Optimization a `departureTime` is then dropped, not rejected).
`_passthrough` is merged last and still overrides any of these parameters.

## Autocomplete → place details

`autocomplete()` returns predictions; `placeDetails()` resolves one into a full
candidate. "Place details" and "geocode by place id" are the same vendor call on all
five providers, so this is one operation, not two — and it returns an ordinary
`IGeocodeCandidate` you can feed straight into whatever already consumes them.

```typescript
const geocoding = new Geocoding('google', { apiKey: process.env.GOOGLE_KEY! });

const { predictions } = await geocoding.autocomplete({ input: 'blue bottle' });

// Render the usual two-line suggestion without splitting `description` on a comma.
for (const p of predictions) {
  console.log(p.structuredFormat?.mainText ?? p.description);
  console.log(p.structuredFormat?.secondaryText ?? '');
}

const { candidate } = await geocoding.placeDetails({ placeId: predictions[0]!.placeId! });
if (candidate === null) {
  // The provider no longer resolves this id (places close, ids expire).
} else {
  console.log(candidate.location); // → { lat, lng }
}
```

`candidate` is `null` when the provider answers "not found" for the id or returns the place
without a location — an answer to branch on, like geocoding's `candidates: []`, never a
fabricated `(0,0)`; `raw` still carries the vendor's body. An id the provider rejects as
invalid stays an `invalid_request` error (Google Places answers an unknown id that way too).

`placeId` values are **provider-scoped** — a Google place id is meaningless to Mapbox.
Use the same facade for both calls.

### Two things that cost money here

**Google's Place Details SKU is driven by the field mask**, so `name`
(`displayName`) is a Pro-tier field and only requested behind an opt-in:

```typescript
await geocoding.placeDetails({ placeId, include: ['name'] });
```

Note this is the *opposite* of Compute Routes, whose SKU is driven by request
*features* — the rule has to be checked per API rather than generalized.

**Mapbox Search Box bills per session, not per request.** A `suggest` and the
`retrieve` that follows count as one billable session only when they carry the same
`session_token`; without one the connector sends a fresh token per call, so each call
bills as its own session:

```typescript
const sessionToken = crypto.randomUUID();          // one per user interaction
await mapbox.autocomplete({ input, sessionToken });
await mapbox.placeDetails({ placeId, sessionToken });
```

The wrapper cannot remember that token across calls — it holds no state — so
threading it through is the consumer's job.

### `structuredFormat` support

| Provider | `mainText` / `secondaryText` |
|---|---|
| Google | `structuredFormat.mainText` / `.secondaryText` — default-on, free |
| Mapbox | `name` / `place_formatted` |
| HERE | `title` / `address.label` — `secondaryText` absent for *query*-type suggestions, which carry no address |
| TomTom | `poi.name` / `address.freeformAddress` — **absent for street results**, which have no `poi.name` |
| Esri | not supported — returns a single flat `text` |

It is **never synthesized**: an absent `structuredFormat` means the provider gave no
distinct main part, and `description` remains the thing to render.

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

Without one, the connectors use `globalThis.fetch`, bound to `globalThis` — runtimes such as
Cloudflare Workers throw "Illegal invocation" when fetch is called with any other receiver.
A `fetch` you pass is invoked exactly as given.

**Contract: a non-2xx must be RETURNED as a `Response`, not thrown.** That is plain
fetch semantics, and it is what lets each connector map the status to a `providerCode`
(429 → `rate_limited`, 401 → `auth_failed`, …) and read the vendor's message.

**Injecting a `fetch` does not isolate you from the host process.** On Node, both
`globalThis.fetch` and `undici.fetch` dispatch through undici's *process-global*
dispatcher, so anything the application installed applies to your calls too — including
a `responseError()` interceptor, under which a non-2xx **rejects** instead of resolving.
The library detects that case and rebuilds the `Response`, so classification still works.
One thing it cannot repair: if the provider gzipped the error body, that interceptor
buffers it below fetch's content-decoding and the bytes are destroyed before any library
sees them, so the vendor's message text is lost.

If you want your calls genuinely isolated from the host's configuration, pass an explicit
dispatcher rather than relying on the global one:

```typescript
import { Agent, fetch as undiciFetch } from 'undici';

const isolated = new Agent();                      // no inherited interceptors
const routing = new Routing(
  'google',
  { apiKey: process.env.GOOGLE_KEY! },
  ((url, init) => undiciFetch(url as string, { ...init, dispatcher: isolated })) as typeof fetch,
);
```

The wrapper holds no state — no token cache, no connection pool, no retry buffer. Every
operation is a single function call from input to output with one HTTP round-trip
(except HERE Matrix v8, which transparently runs a submit → poll → retrieve cycle behind
a single `await matrix(input)`).

## Error handling

Every **operation** failure rejects with `ConnectorError` and a typed `providerCode`: a
vendor error, a transport failure, a timeout, or request data the library refuses before
sending it (non-finite coordinates, too few waypoints, an invalid `Date`, a malformed country
code, …; those carry `statusCode: null`). Compose your own retry strategy from
`e.providerCode` and `e.cause` (which carries the raw `Retry-After` header where the vendor
sets one).

Misusing the API itself is a bug in your code, not a runtime failure, and is deliberately
*not* a `ConnectorError`: it is a `TypeError`. The facade constructor throws it synchronously
for an unknown provider (or one without that operation) or a missing config; the operation
rejects with it for a value outside a string-literal union, such as `travelMode: 'flying'`, an
unknown `include` token or a `departureTime` that is not a `Date`. Validate end-user input
against those unions at your own boundary rather than catching the `TypeError`.

That includes a 2xx the connector cannot interpret — an unparseable body, a missing or
mistyped field, a route without legs, an isochrone without a polygon: it raises `unknown`
(or `no_route` for a route with no legs) with the vendor body on `cause`, rather than
leaking a raw `TypeError` or returning zeros and empty lists the provider never sent. A
well-formed "zero results" answer stays an empty result.

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
      case 'unsupported_field':       /* drop the field the provider lacks    */ break;
      case 'unsupported_option':      /* drop OSRM-incompatible option        */ break;
      case 'unsupported_travel_mode': /* fall back to a supported travel mode */ break;
      case 'profile_not_configured':  /* compile the OSRM profile             */ break;
      case 'matrix_polling_timeout':  /* resume via e.cause.matrixId          */ break;
      case 'no_route':                /* no route between these points        */ break;
      case 'timeout':                 /* request exceeded the transport bound */ break;
      case 'unknown':                 /* fallback                             */ break;
    }
  } else throw e;
}
```

### When the provider's error body never arrived

If the host process reconfigured undici's global dispatcher to reject non-2xx responses
(see *Bring your own `fetch`* above), a **gzipped** error body is destroyed before any
library can read it. The status still classifies correctly, but the vendor's message is
gone — and a connector that classifies *from* the body (Google answers HTTP 400 for both
an invalid key and a malformed request) reports `unknown` rather than guessing.

`cause` states when this happened, so a missing `providerMessage` is never unexplained:

```jsonc
{ "_thinwrapErrorBodyUnavailable": "gzip" }
```

Pass an explicit dispatcher (shown above) to avoid it entirely.

### `no_route` — "there is no route", normalized

The providers agree on nothing here. Google answers HTTP **200** with the `routes` key
absent; HERE 200 with `routes: []` plus a `notices[].code`; Mapbox `code: "NoRoute"` on
either 200 or 422; OSRM the same codes on a **400**; TomTom a 400 with
`detailedError.code`; Esri a 200 whose in-body `error.code: 400` names an **unlocated**
stop in `details[]`. One code covers all six, so branching on "no usable route" does not
mean reimplementing them:

```typescript
if (e instanceof ConnectorError && e.providerCode === 'no_route') {
  // Well-formed request, provider answered, no route exists. A business
  // outcome — not a bug to fix and not worth retrying.
}
```

In practice this almost always means *a waypoint could not be matched to the road
network* rather than *the road network is disconnected*: every provider tested happily
routes Reykjavik→Oslo via ferry.

### `timeout`

Requests carry a default 30-second bound so a hung provider cannot leave a promise
pending forever. Timeout policy remains a BYO-transport concern — supply your own
`fetch` with its own signal and it fires first.

The wrapper performs no automatic retry. The `Retry-After` header (when present on
HTTP 429) is surfaced via `e.cause.retryAfter` (raw header string) and the parsed
seconds count is woven into `e.providerMessage` (`…; retry after N seconds`). There is
**no** structured `retryAfterSeconds` field on `ConnectorError`.

## `_passthrough` escape valve

When the normalized input doesn't expose a vendor-specific field, forward arbitrary
keys via `_passthrough`. The wrapper deep-merges `body`, shallow-merges `headers` and
`query`. Consumer values win on conflict. Keys are forwarded verbatim — no casing
transformation. Header names are matched case-insensitively, as HTTP defines them: a
passthrough `x-goog-fieldmask` replaces the connector's `X-Goog-FieldMask` (and your spelling
is the one sent) instead of both going out and being joined into one value.

```typescript
import { GOOGLE_ROUTES_FIELD_MASK } from '@thinwrap/location';

await routing.route({
  waypoints: [origin, destination],
  _passthrough: {
    body:    { languageCode: 'fr', units: 'IMPERIAL' },
    headers: { 'X-Goog-FieldMask': [...GOOGLE_ROUTES_FIELD_MASK, 'routes.travelAdvisory'].join(',') },
    query:   { region: 'us' },
  },
});
```

A header or query value — and a body array — is replaced whole, so a list-valued
one (Google's `X-Goog-FieldMask`, HERE's `return` and `matrixAttributes`, Mapbox and
OSRM matrix `annotations`, Esri's `accumulateAttributeNames`) **replaces** the
connector's list rather than adding to it. That is what lets you drop a default; to
add to one, spread the published constant as above (`GOOGLE_ROUTES_FIELD_MASK`,
`GOOGLE_MATRIX_FIELD_MASK`, `GOOGLE_PLACE_DETAILS_FIELD_MASK`, `HERE_ROUTING_RETURN`,
`HERE_MATRIX_ATTRIBUTES`, `MAPBOX_MATRIX_ANNOTATIONS`, `OSRM_TABLE_ANNOTATIONS`,
`ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING` / `_WALKING`,
`ESRI_MATRIX_ACCUMULATE_ATTRIBUTES`, plus the Google conditional groups). A
replacement list that leaves out a default value empties or zeroes the normalized
output it feeds, or makes the call raise `unknown` — see "Replacing a default list"
in the [Google](src/providers/google/README.md#replacing-a-default-list),
[HERE](src/providers/here/README.md#replacing-a-default-list),
[Mapbox](src/providers/mapbox/README.md#replacing-a-default-list),
[OSRM](src/providers/osrm/README.md#replacing-a-default-list) and
[ESRI](src/providers/esri/README.md#replacing-a-default-list) READMEs.

Each per-connector README documents its vendor-specific `_passthrough` examples.

## Isochrone contours

Each contour's `geometry` is a GeoJSON `Polygon` for one connected area — the common case — or a
`MultiPolygon` holding every part when the provider returns several disconnected areas for the
break (an island reached by ferry, a region split by water; HERE and ESRI document this).
The nesting depth differs, so read `geometry.type` before indexing `coordinates`:

```typescript
import { Isochrone } from '@thinwrap/location';

const { contours } = await new Isochrone('here', { apiKey: 'YOUR_KEY' }).isochrone({
  center: { lat: 60.17, lng: 24.94 }, type: 'time', values: [900],
});
for (const { geometry } of contours) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  // each polygon is [exterior, ...holes], every ring closed and in [lng, lat] order
}
```

On every provider, holes are kept and rings are wound per RFC 7946 (exterior counter-clockwise,
holes clockwise), whatever winding the provider used.

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

## Security

Report vulnerabilities **privately** — please do not open a public issue. Preferred: a
[private security advisory](https://github.com/thinwrap/location-ts/security/advisories/new)
on this repository. Alternatively, email **security@thinwrap.dev**. Include the affected
versions and a minimal reproduction if you have one.

A vulnerability in a *provider's* own API or service belongs to that vendor rather than
to this wrapper — please report those upstream.

Supply chain: releases are published to npm via GitHub Actions OIDC
trusted-publishing with **Sigstore provenance attestation** — verify an installed copy
with `npm audit signatures @thinwrap/location@<version>`. No long-lived npm publish
token exists in this repository or its CI secrets, the publishing account requires
two-factor authentication (TOTP, with npm's `auth-and-writes` setting), and CI consumes
no external reusable workflows.

## License

MIT.
