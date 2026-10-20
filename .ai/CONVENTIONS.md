# `@thinwrap/location` — Conventions

Naming, file layout, and test patterns for AI agents adding or refactoring a connector.

Each provider's per-connector `README.md` is plain Markdown — it opens directly with its
`# Title` (no YAML metadata block). It is the connector's consumer-facing doc; keep it
complete and at parity with the sibling-language libraries.

## Where files live in this repo

```
src/
  index.ts                              # public-API barrel
  base/                                 # BaseConnector (HTTP + error wrapping)
  facades/                              # Routing/Matrix/Geocoding/Isochrone facades + *.spec.ts
  providers/<contract>.spec.ts          # cross-provider contract spec — see below
  providers/<provider>/                 # one directory per provider — 6 total
    index.ts                            # re-exports for the provider
    <provider>.config.ts                # <Provider>Config interface
    <provider>.types.ts                 # narrowed input/result types + vendor response shapes
    <provider>.<op>.connector.ts        # one connector class per operation
    <provider>.<op>.connector.spec.ts   # vitest spec — co-located, never in top-level tests/
    README.md                           # per-connector consumer doc (plain Markdown)
  types/                                # cross-operation interfaces, ProviderCode, LatLng, ConnectorError
  utils/                                # mergePassthrough, polyline utilities, coordinate helpers,
                                        # isTrafficRequested (the one place 'live' = 'traffic')
scripts/
  # build/packaging + lint helpers
.ai/
  guidelines.md                         # contributor entry point + add-a-connector recipe
  ARCHITECTURE.md                       # 6 location-distinctive invariants
  CONVENTIONS.md                        # this file
.github/workflows/
  ci.yml                                # OS × Node matrix + tests + lint + bundle-size
  lint-gates.yml                        # license, lifecycle scripts, README/.ai presence
  release.yml                           # OIDC publish on v* tag
```

Connector source lives under `src/providers/<id>/`; all in-tree references use this
canonical path.

## Provider-ID literal types

Provider IDs are TypeScript string-literal unions per operation, declared in
`src/types/config-map.type.ts`. Adding a connector means extending the union plus the
`ProviderConfigMap` row plus the operation facade's `createXxxConnector` switch.

```typescript
export type RoutingProvider   = 'google' | 'mapbox' | 'here' | 'esri' | 'tomtom' | 'osrm';
export type MatrixProvider    = 'google' | 'mapbox' | 'here' | 'esri' | 'tomtom' | 'osrm';
export type GeocodingProvider = 'google' | 'mapbox' | 'here' | 'esri' | 'tomtom';
export type IsochroneProvider = 'mapbox' | 'here' | 'esri' | 'tomtom';
```

## File naming

| File | Required? | Purpose |
|---|---|---|
| `<provider>.<op>.connector.ts` | yes | Connector class extending `BaseConnector` |
| `<provider>.<op>.connector.spec.ts` | yes | vitest spec, co-located |
| `<provider>.config.ts` | yes | Exported `<Provider>Config` interface (shared across ops) |
| `<provider>.types.ts` | yes | Vendor response shapes + per-op narrowed input types |
| `index.ts` | yes | Barrel re-export for the provider directory |
| `README.md` | yes | Per-connector consumer doc (plain Markdown) |

### Cross-provider contract specs

A behaviour that must hold **identically across every provider** gets one spec at
`src/providers/<contract>.spec.ts` instead of the same test copied into six connector
specs — currently `no-route`, `routing-options`, `structured-format`, `place-details` and
`traffic-mode`.
Each carries one case per provider in a single file, so a provider missing from a contract
is visible by reading one list instead of auditing six directories. These are the
invariants a new connector must satisfy: when you add a provider, add its case here too.
Provider-specific behaviour still belongs in the co-located connector spec.

A connector decides traffic only through `isTrafficRequested(options.trafficMode)`
(`src/utils/traffic.ts`), never by comparing to `'traffic'` or `'live'` itself, so the
deprecated `'live'` alias cannot drift apart from `'traffic'` on one provider.
`traffic-mode.spec.ts` checks that both produce the same request.

## Two kinds of failure: `ConnectorError` vs `TypeError`

1. **Operation failures are `ConnectorError`.** Vendor errors, transport failures and
   timeouts, and also **request data the library rejects before sending**: non-finite
   coordinates or radius, too few waypoints, empty origins/destinations, bad isochrone
   breaks, a malformed or unmappable country code, an invalid `Date` or unparseable
   isochrone time, a bad `timeoutMs`, a missing or schemeless OSRM `baseUrl`, Esri
   credentials that are both set (`invalid_request`) or neither set (`auth_failed`). And
   **capability rejections** (`unsupported_*`). They are raised by the operation call, as a
   rejection, with `statusCode: null` and before any network I/O.
2. **API misuse is a bug in the calling code: a native `TypeError`, as early as possible,
   never a `ConnectorError`.** An unknown provider or one without the operation, and a
   null/non-object config, throw synchronously from the facade constructor
   (`src/facades/assert-config.ts`). A value outside a closed vocabulary (`travelMode`,
   `trafficMode` — `'none' | 'traffic' | 'live'` — `polylineQuality`, `include` tokens,
   isochrone `type`) or a wrong argument type (a `departureTime` that is not a `Date`)
   rejects from the operation. Direct connector construction keeps its call-time checks
   (e.g. `new OsrmRoutingConnector(null)` rejects with `invalid_request`).

**Tie-breaker, the substitution test.** A pre-flight check exists to save a round-trip, so
it must never change the *type* of error the caller would have got by sending anyway, only
improve the code and message. If sending would have ended in a vendor 4xx or a transport
failure (both `ConnectorError`), the check raises `ConnectorError`. If the library could not
even form the request, because it translates the vocabulary and no vendor would ever see
`'flying'`, the check is a `TypeError`. Values forwarded verbatim (HERE `transportMode`)
stay vendor-side `ConnectorError`s.

Where the checks live:

- Vocabulary: `src/utils/assert-one-of.ts` (`assertOneOf`, `assertTokens` and the
  vocabulary arrays). `undefined` always keeps the documented default.
- Per operation: `validateRoutingOptions` / `validateMatrixOptions` /
  `validatePlaceDetailsOptions` in `src/utils/validate-options.ts`, and
  `validateIsochroneCap` for isochrone. Each connector calls its helper first thing in the
  (async) operation method, so the outcome never depends on the provider.
- `departureTime`: `assertValidDate` (`src/utils/datetime.ts`) — non-`Date` → `TypeError`,
  invalid `Date` → `invalid_request`, checked even where the time is then dropped.

`src/error-contract.spec.ts` pins the rule table-driven over case × provider, including a
negative `not.toBeInstanceOf(ConnectorError)` for every `TypeError` row and zero `fetch`
calls for every row. A new connector, or a new closed vocabulary, adds its rows there. Do not
"helpfully" wrap a `TypeError` in `ConnectorError`: consumers treat `invalid_request` as bad
end-user input, so a wrapped bug would be reported to end users instead of alerting.

## `mapVendorError(status, body)` pattern

Each connector implements `private mapVendorError(httpStatus: number, body: unknown): ProviderCode`.
Canonical baseline mapping (override per vendor when the response carries finer signal):

| HTTP status | Default `providerCode` |
|---|---|
| 400 | `invalid_request` |
| 401 | `auth_failed` |
| 403 | `auth_failed` (or `rate_limited` if vendor signals quota) |
| 404 | `invalid_request` |
| 422 | `invalid_request` |
| 429 | `rate_limited` |
| 5xx | `provider_unavailable` |
| network failure | `provider_unavailable` |
| unparseable | `unknown` |

Plus the 7 location-extended codes, raised by **pre-flight validation** (OSRM mostly),
**wire-translation** (HERE Matrix polling timeout, TomTom unsupported travel mode),
**response inspection** (`no_route` — see below), and the **transport bound**
(`timeout`, set by `BaseConnector` when its own `AbortSignal` fired).

`no_route` is the one code that cannot be read off the HTTP status: the vendors serve
"no route exists" on 200 (Google, HERE, Esri), 422 (Mapbox) and 400 (OSRM, TomTom).
Each `mapVendorError` matches the vendor's envelope code instead.

## `Retry-After` surfacing pattern

The wrapper does NOT carry a structured `retryAfterSeconds` field on `ConnectorError`.
When the vendor sets `Retry-After`, the connector:

```typescript
const errorBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
const retryAfter = response.headers.get('retry-after');
const cause = retryAfter !== null ? { ...(errorBody ?? {}), retryAfter } : errorBody;

const parsedSeconds = retryAfter !== null ? parseInt(retryAfter, 10) : NaN;
const baseMessage = readVendorErrorMessage(errorBody);
const providerMessage = Number.isFinite(parsedSeconds)
  ? (baseMessage !== null ? `${baseMessage}; retry after ${parsedSeconds} seconds` : `retry after ${parsedSeconds} seconds`)
  : baseMessage;

throw new ConnectorError({ statusCode: response.status, providerCode: 'rate_limited', providerMessage, cause });
```

Spec tests assert:
- `cause.retryAfter === '<raw header string>'`
- `providerMessage` contains `'N seconds'` for parseable headers.
- **Do NOT** assert `retryAfterSeconds` — that field does not exist.

## Test pattern (vitest)

Inject a `vi.fn()` mock fetch via the third constructor parameter. No module-level
`vi.mock` of fetch; the suite supports parallel test files because every spec owns its
own mock instance.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GoogleRoutingConnector } from './google.routing.connector';

describe('GoogleRoutingConnector', () => {
  it('POSTs to the Routes v2 endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ routes: [{ legs: [], distanceMeters: 100, duration: '60s', polyline: { encodedPolyline: '_a' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const g = new GoogleRoutingConnector({ apiKey: 'k' }, fetchMock);
    await g.route({ waypoints: [{ lat: 40.7, lng: -74 }, { lat: 41.4, lng: -73 }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

### Optional fixture extraction

Specs may inline their request/response fixtures (the v1.0 default) or extract them to
`test/fixtures/<provider>/<operation>/<scenario>.{request,response}.json`. Extraction
is encouraged for fixtures shared across multiple specs but never forced. The
brownfield specs use the inline pattern.

## `mergePassthrough` + augmentation pattern

Inside each connector, after building the vendor body / headers / query:

```typescript
import { mergePassthrough } from '../../utils';

const merged = mergePassthrough(body, headers, options._passthrough);
const response = await this.sendPostJson(URL, merged.body, { headers: merged.headers });
```

- `mergePassthrough` does **deep** merge on body, **shallow** merge on headers + query.
- Consumer values win on conflict (last-write-wins).
- `_passthrough` keys are forwarded verbatim — no casing transformation.
- A list-valued default that a passthrough key replaces whole (a field mask, a
  `return` list, a body array) is set BEFORE the merge — never forced after it — and lives as an exported, `Object.freeze`d `as const` array in
  `src/providers/<id>/<id>.defaults.ts`, re-exported from `src/index.ts`, and the
  connector builds the wire value from it — so consumers can spread-and-append, and
  the published list cannot drift from what is sent. Add new ones to
  `DEFAULT_LISTS` in `scripts/check-dist.mjs`.

Operation-specific augmentations follow the
`{Op}OptionsMap<P extends Provider>` pattern; v1.0 has no augmentations, so
`RoutingOptionsFor<P>` resolves to `IRoutingOptions` for every provider. Future
augmentations add per-provider narrowed types via a `<provider>.types.ts` declaration.

## TypeScript / lint / build

- `tsconfig.json` is `strict: true` with `noUncheckedIndexedAccess`. Target ES2021,
  lib ES2022 (for native `Error.cause`).
- ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`. Key rules:
  `consistent-type-imports: error`, `no-explicit-any: warn`.
- `npm run typecheck` (`tsc --noEmit`) clean is the canary AC for any provider rewrite.
- Dual build emits to `dist/cjs/` and `dist/esm/`. Public API surface comes only from
  `src/index.ts`.
