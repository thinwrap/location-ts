# Bundle-size entry points

Each `.ts` file in this directory is a single-import tree-shaken entry point used
by the `bundle-size-tier-check.yml` reusable workflow (consumed by `.github/workflows/ci.yml`).

The reusable workflow bundles each entry through esbuild with tree-shaking enabled
(the package's `"sideEffects": false` in `package.json` makes this safe) and
measures gzipped + minified output. The thresholds enforced are:

- **Single-provider × operation imports**: < 12 KB gzipped (21 files).
- **All-provider import** (`all.ts`): < 40 KB gzipped (1 file).
- **Polyline utilities only** (`polyline-only.ts`): < 5 KB gzipped (1 file).

Total: 23 files (21 single-provider × operation entries + the "all-provider"
entry + the polyline-utilities entry).

## Override mechanism

A legitimate ceiling-push (e.g., new provider tier) is allowed via a commit
trailer on the release commit:

```
[bundle-size: override]
```

The override is logged + reviewed by the umbrella reusable workflow but does
not block. v1.0 has no expected overrides.

## Why this shape

Bundlers (esbuild, Webpack, Vite, Rollup) all support named-import tree-shaking
on this package because:

1. `package.json` sets `"sideEffects": false`.
2. The package ships dual-build CJS + ESM (`./dist/esm/index.js` is the `module`
   entry).
3. Each connector class is a discrete top-level export with no module-level
   side effects (verified by the network-disabled-smoke CI job).

Each entry file uses ONLY named imports — no `import *`, no default-import
re-export tricks that defeat tree-shaking.
