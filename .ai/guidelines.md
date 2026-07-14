# `@thinwrap/location` — contributor guide

This folder (`.ai/`) is for developers — and the coding agents working alongside them — who are
**changing this library**: adding a connector or operation, or improving the package. It is not
usage documentation.

> **Using the package in your app?** See [`../README.md`](../README.md) and the per-connector
> READMEs under [`../src/providers/`](../src/providers). `.ai/` is not part of the npm tarball —
> its only audience is people working in the repo.

## Map of this folder

- **guidelines.md** (this file) — entry point + the "add a connector" recipe.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the facade → dispatch → base model and the location-distinctive invariants every change must hold.
- [`CONVENTIONS.md`](./CONVENTIONS.md) — file layout, naming, error mapping, `_passthrough`, TypeScript/build config, per-connector README frontmatter.

## The shape in one sentence

A consumer constructs an operation facade by provider id (`new Routing('google', cfg)`); the facade
dispatches to a per-operation connector class under `src/providers/<id>/` that extends
`BaseConnector`, which centralizes `fetch` + JSON parsing + error mapping. No global middleware —
vendor specifics and result normalization stay local to the connector.

## Setup & verify

```bash
npm install
npm run typecheck && npm test
```

Node ≥18 (native `fetch`). **Zero runtime dependencies — do not add any** (SigV4 for Esri is
hand-rolled on `node:crypto`).

## Add a connector

One operation = one connector class per provider. Copy [`src/providers/google/`](../src/providers/google)
as your template (it implements routing + matrix + geocoding). Touch-points, in order:

1. **Register the id** — add the case to [`src/types/provider-id.enum.ts`](../src/types/provider-id.enum.ts).
2. **Wire the config + provider unions** — add `'<id>': <Name>Config` and add the id to each operation's provider union in [`src/types/config-map.type.ts`](../src/types/config-map.type.ts) (only the operations this provider supports).
3. **Create `src/providers/<id>/`**:
   - `<id>.config.ts` — `<Name>Config` interface.
   - `<id>.<operation>.connector.ts` — one per supported operation (`routing`/`matrix`/`geocoding`/`isochrone`); `extends BaseConnector`, `readonly providerId`, the operation method, private `mapVendorError(...)`.
   - `<id>.<operation>.connector.spec.ts` — vitest; inject a `vi.fn()` fetch mock (see CONVENTIONS).
   - `<id>.types.ts` — vendor response shapes + any narrowed input augmentations.
   - `index.ts` — barrel re-export.
   - `README.md` — a single top-of-file YAML frontmatter block (opening `---` on line 1) with each operation keyed under `operations:` (schema: [`../schemas/connector-readme-schema.yaml`](../schemas/connector-readme-schema.yaml)) + body. Keep the block at the very top or GitHub leaks the raw YAML into the page. **This** is the connector's consumer doc.
4. **Dispatch** — add the case to each relevant facade in [`src/facades/`](../src/facades) (`routing.facade.ts`, `matrix.facade.ts`, …).
5. **Export** — re-export the connectors + config from [`src/index.ts`](../src/index.ts), the only public surface.
6. **Bundle-size** — add the per-provider × per-operation entry points the bundle-size CI gate measures.

### Definition of done (the CI gates)

```bash
npm run typecheck            # strict; enum / provider-union sync
npm test                     # vitest — single file: npx vitest src/providers/<id>/<id>.routing.connector.spec.ts
npm run lint
npm run lint:frontmatter     # validates every connector README against the schema
npm run build && npm run check:dist   # dual CJS/ESM emit + import smoke
```

CI also runs a Node 18/20/22 × Linux/macOS/Windows matrix, a bundle-size gate, and an offline
import smoke that proves zero import-time egress.

## Invariants you must not break

Full reasoning lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md); the short list:

- **Zero runtime deps / no vendor SDKs.**
- **Stateless wrapper.** No caching, retries, idempotency keys, or telemetry. (HERE Matrix submit/poll/retrieve is transient, inside a single call.)
- **≥90% baseline-coverage rule.** A field belongs on the base operation input only if ≥90% of that operation's providers support it; everything else goes to `_passthrough` (input) / `raw` (output) or a narrowed type.
- **Normalize at the wire layer.** Distance → meters, duration → seconds, coordinates → `{ lat, lng }`, geometry → Google precision-5 polyline. The four `Polyline` utilities are locked at v1.0.
- **Per-connector locality.** `mapVendorError` and any outlier translation live inside `src/providers/<id>/` — never in `BaseConnector`. No casing-transform layer; keys are forwarded verbatim.
- **`ProviderCode`**: 6 canonical + 5 location-extended values, surfaced via `ConnectorError`; the raw `Retry-After` rides in `e.cause` (no top-level `retryAfterSeconds`).
- **OSRM** requires an explicit `baseUrl` and validates it pre-flight.
