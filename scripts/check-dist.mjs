// Import-smoke the built dual package exactly the way Node consumers load
// it — no bundler in the loop. Bundlers (vitest, the bundle-size gate)
// tolerate extensionless specifiers that Node's ESM loader rejects, so this
// is the only gate that catches a broken dist/esm emit (the
// @thinwrap/notifications v1.0.0 bug class).
// Runs offline; requires `npm run build` first.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();

const EXPECT = ['Routing', 'Matrix', 'Geocoding', 'Isochrone', 'ConnectorError', 'GoogleRoutingConnector', 'encodePolyline'];

// The published default lists a caller spreads into a replacing `_passthrough`.
// They must ship as frozen, non-empty string arrays: a missing or mutable one
// would either break the documented append recipe or let one caller rewrite the
// list every later request is built from.
const DEFAULT_LISTS = [
  'GOOGLE_ROUTES_FIELD_MASK',
  'GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC',
  'GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER',
  'GOOGLE_MATRIX_FIELD_MASK',
  'GOOGLE_PLACE_DETAILS_FIELD_MASK',
  'GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME',
  'HERE_ROUTING_RETURN',
  'HERE_MATRIX_ATTRIBUTES',
  'MAPBOX_MATRIX_ANNOTATIONS',
  'OSRM_TABLE_ANNOTATIONS',
  'ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING',
  'ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING',
  'ESRI_MATRIX_ACCUMULATE_ATTRIBUTES',
];

function assertSurface(mod, label) {
  for (const name of EXPECT) {
    if (typeof mod[name] !== 'function') {
      console.error(`check-dist: ${label} export '${name}' is ${typeof mod[name]}, expected function`);
      process.exit(1);
    }
  }
  for (const name of DEFAULT_LISTS) {
    const list = mod[name];
    const ok =
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((v) => typeof v === 'string') &&
      Object.isFrozen(list);
    if (!ok) {
      console.error(`check-dist: ${label} export '${name}' is not a frozen, non-empty string array`);
      process.exit(1);
    }
  }
}

// CJS — full graph loads through Node's require resolution.
const cjsMod = require(resolve(root, 'dist/cjs/index.js'));
assertSurface(cjsMod, 'cjs');

// ESM — full graph loads through Node's ESM resolution (this is what
// rejects extensionless/directory specifiers).
const esmMod = await import(pathToFileURL(resolve(root, 'dist/esm/index.js')));
assertSurface(esmMod, 'esm');

for (const name of DEFAULT_LISTS) {
  if (JSON.stringify(cjsMod[name]) !== JSON.stringify(esmMod[name])) {
    console.error(`check-dist: '${name}' differs between the cjs and esm builds`);
    process.exit(1);
  }
}

// --- Module augmentations must survive the emit ---------------------------
//
// The per-provider narrowed inputs (Google/Mapbox `sessionToken`) are shipped as
// `declare module` augmentations. Three separate things silently drop them, none
// of which any in-repo check can see, because inside this repo the augmentation
// resolves fine:
//
//   1. The declaring file is unreachable from `index.d.ts` (nothing imports it),
//      so a consumer's compiler never loads it.
//   2. A top-level `import type` used only inside the block is elided, leaving
//      dangling type names.
//   3. The `declare module '<relative>'` TARGET is extensionless, so under
//      `moduleResolution: node16/nodenext` it does not resolve — and an
//      unresolvable augmentation target is NOT an error, the augmentation is just
//      ignored.
//
// (3) is the nastiest: entirely silent. Mapbox's `sessionToken` shipped unusable
// because of it. Assert the shape here rather than trusting the emit.
const { readFileSync } = await import('node:fs');

const AUGMENTED = [
  ['dist/esm/providers/google/google.config.d.ts', ['AutocompleteOptionsMap', 'PlaceDetailsOptionsMap']],
  ['dist/esm/providers/mapbox/mapbox.config.d.ts', ['AutocompleteOptionsMap', 'PlaceDetailsOptionsMap']],
];

for (const [file, maps] of AUGMENTED) {
  const dts = readFileSync(resolve(root, file), 'utf8');

  for (const map of maps) {
    if (!dts.includes(`interface ${map}`)) {
      console.error(`check-dist: ${file} lost its '${map}' augmentation`);
      process.exit(1);
    }
  }

  // Every `declare module` target and inline import specifier must carry an
  // extension, or the augmentation is silently dropped for consumers.
  for (const re of [/declare module '(\.\.?\/[^']+)'/g, /import\('(\.\.?\/[^']+)'\)/g]) {
    for (const [, spec] of dts.matchAll(re)) {
      if (!spec.endsWith('.js')) {
        console.error(
          `check-dist: ${file} has extensionless specifier '${spec}' — ` +
            `the augmentation will be silently ignored by consumers on moduleResolution node16/nodenext`,
        );
        process.exit(1);
      }
    }
  }
}

// --- Published declarations may only reference shipped dependencies ---------
//
// A `.d.ts` that imports a package the consumer does not install breaks their
// build (TS2307), or — with `skipLibCheck` — silently widens the type to `any`.
// The consumer probe below cannot catch it: it resolves this package through a
// SYMLINK, so every devDependency in this repo's node_modules is still visible
// to it. So scan the emitted declarations for bare module specifiers and allow
// only `dependencies` / `peerDependencies` (a `node:` builtin would demand
// `@types/node` from every consumer, so it is not allowed either).
{
  const { readdirSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const allowed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const packageOf = (spec) =>
    spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : e.name.endsWith('.d.ts') ? [resolve(dir, e.name)] : [],
    );

  // Block comments are stripped first: JSDoc prose such as "from 'the provider'"
  // must not read as an import. Triple-slash directives are line comments and
  // survive.
  const SPECIFIER_PATTERNS = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"]+)['"]/gm,
    /^\s*declare\s+module\s+['"]([^'"]+)['"]/gm,
  ];

  const offending = [];
  for (const file of walk(resolve(root, 'dist'))) {
    const dts = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of SPECIFIER_PATTERNS) {
      for (const [, spec] of dts.matchAll(re)) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (allowed.has(packageOf(spec))) continue;
        offending.push(`${file.slice(root.length + 1)} → '${spec}'`);
      }
    }
  }
  if (offending.length > 0) {
    console.error(
      'check-dist: published declarations reference modules that are not dependencies ' +
        `or peerDependencies, so consumers cannot resolve them:\n  ${offending.join('\n  ')}`,
    );
    process.exit(1);
  }
}

// The checks above are proxies for the property we actually care about, and a proxy
// can pass while the property is false: reachability was previously asserted by
// looking for `providers/<id>/index.js` in `index.d.ts`, which stayed true while
// three augmentations (HERE `transportMode`, Mapbox/TomTom isochrone `'cycling'`)
// were invisible to consumers. So typecheck a real consumer against the built
// package — the only check that observes what a consumer observes.
const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { spawnSync } = await import('node:child_process');

const probeDir = mkdtempSync(resolve(tmpdir(), 'thinwrap-dist-probe-'));
mkdirSync(resolve(probeDir, 'node_modules/@thinwrap'), { recursive: true });
symlinkSync(root, resolve(probeDir, 'node_modules/@thinwrap/location'), 'dir');
// `type: module` so `moduleResolution: nodenext` treats each probe as ESM — the
// mode a consumer's compiler uses, and the one that rejects an extensionless
// `declare module` target.
writeFileSync(resolve(probeDir, 'package.json'), '{"type":"module"}');

const TSC_FLAGS = [
  '--noEmit',
  '--strict',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--target',
  'es2022',
];

// One line per shipped augmentation. `expectError` lines prove the gate has teeth:
// if the base narrowing were lost, they would compile and the gate would be vacuous.
const PROBES = {
  'here-routing.ts': `import { Routing } from '@thinwrap/location';
await new Routing('here', { apiKey: 'k' }).route({
  waypoints: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], transportMode: 'truck' });`,
  'here-matrix.ts': `import { Matrix } from '@thinwrap/location';
await new Matrix('here', { apiKey: 'k' }).matrix({
  origins: [{ lat: 1, lng: 2 }], destinations: [{ lat: 3, lng: 4 }], transportMode: 'truck' });`,
  'mapbox-isochrone.ts': `import { Isochrone } from '@thinwrap/location';
await new Isochrone('mapbox', { accessToken: 't' }).isochrone({
  center: { lat: 1, lng: 2 }, type: 'time', values: [300], travelMode: 'cycling' });`,
  'tomtom-isochrone.ts': `import { Isochrone } from '@thinwrap/location';
await new Isochrone('tomtom', { apiKey: 'k' }).isochrone({
  center: { lat: 1, lng: 2 }, type: 'time', values: [300], travelMode: 'cycling' });`,
  'google-session.ts': `import { Geocoding } from '@thinwrap/location';
const g = new Geocoding('google', { apiKey: 'k' });
await g.autocomplete({ input: 'x', sessionToken: 't' });
await g.placeDetails({ placeId: 'p', sessionToken: 't' });`,
  'mapbox-session.ts': `import { Geocoding } from '@thinwrap/location';
const m = new Geocoding('mapbox', { accessToken: 't' });
await m.autocomplete({ input: 'x', sessionToken: 't' });
await m.placeDetails({ placeId: 'p', sessionToken: 't' });`,
  // A `.cts` file resolves the package's `require` condition, so this probes the
  // CJS declarations (dist/cjs) — the ESM probes above only ever see dist/esm.
  'mapbox-session-cjs.cts': `import { Geocoding } from '@thinwrap/location';
const m = new Geocoding('mapbox', { accessToken: 't' });
export const run = async () => {
  await m.autocomplete({ input: 'x', sessionToken: 't' });
  await m.placeDetails({ placeId: 'p', sessionToken: 't' });
};`,
  // The contour geometry must be a real type, not `any`: a lost GeoJSON type
  // would let this assignment compile.
  'isochrone-geometry.expectError.ts': `import type { IIsochroneContour } from '@thinwrap/location';
const geometry: IIsochroneContour['geometry'] = { type: 'Point', coordinates: [1, 2] };
export { geometry };`,
  'isochrone-geometry.ts': `import type { GeoJsonPolygon, IIsochroneContour } from '@thinwrap/location';
const g: IIsochroneContour['geometry'] = { type: 'Polygon', coordinates: [[[1, 2], [3, 4], [1, 2]]] };
const ring: number[][] = g.coordinates[0]!;
const same: GeoJsonPolygon = g;
export { ring, same };`,
  // A multi-part contour is a MultiPolygon: the union must ship in both
  // declaration trees, with the discriminant narrowing each branch.
  'isochrone-multipolygon.ts': `import type { GeoJsonMultiPolygon, IIsochroneContour } from '@thinwrap/location';
const m: GeoJsonMultiPolygon = { type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 4], [1, 2]]]] };
const g: IIsochroneContour['geometry'] = m;
const exterior = (c: IIsochroneContour): number[][] =>
  c.geometry.type === 'MultiPolygon' ? c.geometry.coordinates[0]![0]! : c.geometry.coordinates[0]!;
export { g, exterior };`,
  'isochrone-multipolygon-cjs.cts': `import type { GeoJsonMultiPolygon, IIsochroneContour } from '@thinwrap/location';
export const g: IIsochroneContour['geometry'] = { type: 'MultiPolygon', coordinates: [] } satisfies GeoJsonMultiPolygon;`,
  // expectError: without narrowing on `type` the nesting depth is unknown, so
  // treating a position as a number must not compile — proves the union shipped,
  // not a Polygon-only geometry.
  'isochrone-multipolygon.expectError.ts': `import type { IIsochroneContour } from '@thinwrap/location';
export const f = (c: IIsochroneContour): string => c.geometry.coordinates[0]![0]![0]!.toFixed(1);`,
  // The documented append recipe for the published default lists, through both
  // declaration trees.
  'default-lists.ts': `import { Routing, GOOGLE_ROUTES_FIELD_MASK, HERE_ROUTING_RETURN } from '@thinwrap/location';
await new Routing('google', { apiKey: 'k' }).route({
  waypoints: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
  _passthrough: { headers: { 'X-Goog-FieldMask': [...GOOGLE_ROUTES_FIELD_MASK, 'routes.travelAdvisory'].join(',') } } });
await new Routing('here', { apiKey: 'k' }).route({
  waypoints: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
  _passthrough: { query: { return: [...HERE_ROUTING_RETURN, 'turnByTurnActions'].join(',') } } });`,
  'default-lists-cjs.cts': `import { GOOGLE_MATRIX_FIELD_MASK, GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME } from '@thinwrap/location';
export const masks: readonly string[] = [...GOOGLE_MATRIX_FIELD_MASK, ...GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME];`,
  // expectError: the lists are readonly in the published types, not only frozen
  // at runtime — mutating one must not compile.
  'default-lists.expectError.ts': `import { GOOGLE_ROUTES_FIELD_MASK } from '@thinwrap/location';
GOOGLE_ROUTES_FIELD_MASK.push('routes.travelAdvisory');`,
  // expectError: HERE has no isochrone augmentation, so it must stay at the
  // two-value base and reject 'cycling'.
  'here-isochrone.expectError.ts': `import { Isochrone } from '@thinwrap/location';
await new Isochrone('here', { apiKey: 'k' }).isochrone({
  center: { lat: 1, lng: 2 }, type: 'time', values: [300], travelMode: 'cycling' });`,
  // `'traffic'` plus the deprecated `'live'` alias must both ship in the
  // published `TrafficMode`, in both declaration trees.
  'traffic-mode.ts': `import { Routing, Matrix, type TrafficMode } from '@thinwrap/location';
const modes: TrafficMode[] = ['none', 'traffic', 'live'];
await new Routing('google', { apiKey: 'k' }).route({
  waypoints: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], trafficMode: 'traffic' });
await new Matrix('tomtom', { apiKey: 'k' }).matrix({
  origins: [{ lat: 1, lng: 2 }], destinations: [{ lat: 3, lng: 4 }], trafficMode: 'traffic' });
export { modes };`,
  'traffic-mode-cjs.cts': `import type { TrafficMode } from '@thinwrap/location';
export const modes: TrafficMode[] = ['none', 'traffic', 'live'];`,
  // expectError: the union must stay closed, not widen to `string`.
  'traffic-mode.expectError.ts': `import type { TrafficMode } from '@thinwrap/location';
export const mode: TrafficMode = 'typical';`,
};

const tsc = require.resolve('typescript/bin/tsc');
let augFailed = false;

for (const [file, source] of Object.entries(PROBES)) {
  writeFileSync(resolve(probeDir, file), source);
  const expectError = file.includes('.expectError.');
  const { status, stdout } = spawnSync(process.execPath, [tsc, ...TSC_FLAGS, file], {
    cwd: probeDir,
    encoding: 'utf8',
  });
  if (expectError && status === 0) {
    console.error(
      `check-dist: ${file} was expected to FAIL typechecking but compiled — ` +
        `a base narrowing was lost, so the augmentation probes prove nothing`,
    );
    augFailed = true;
  } else if (!expectError && status !== 0) {
    console.error(
      `check-dist: a consumer cannot use the augmentation exercised by ${file} — ` +
        `it typechecks in-repo but is missing from the published types:\n${stdout.trim()}`,
    );
    augFailed = true;
  }
}

if (augFailed) process.exit(1);

console.log(
  'check-dist: cjs + esm entrypoints load clean; augmentations usable by a real consumer',
);
