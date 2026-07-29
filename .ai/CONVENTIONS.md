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
  utils/                                # mergePassthrough, polyline utilities, coordinate helpers
scripts/
  # build/packaging + lint helpers
.ai/
  guidelines.md                         # contributor entry point + add-a-connector recipe
  ARCHITECTURE.md                       # 6 location-distinctive invariants
  CONVENTIONS.md                        # this file
.github/workflows/
  ci.yml                                # OS × Node matrix + tests + lint + bundle-size
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
specs — currently `no-route`, `routing-options`, `structured-format` and `place-details`.
Each carries one case per provider in a single file, so a provider missing from a contract
is visible by reading one list instead of auditing six directories. These are the
invariants a new connector must satisfy: when you add a provider, add its case here too.
Provider-specific behaviour still belongs in the co-located connector spec.

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
