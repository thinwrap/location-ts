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

function assertSurface(mod, label) {
  for (const name of EXPECT) {
    if (typeof mod[name] !== 'function') {
      console.error(`check-dist: ${label} export '${name}' is ${typeof mod[name]}, expected function`);
      process.exit(1);
    }
  }
}

// CJS — full graph loads through Node's require resolution.
assertSurface(require(resolve(root, 'dist/cjs/index.js')), 'cjs');

// ESM — full graph loads through Node's ESM resolution (this is what
// rejects extensionless/directory specifiers).
assertSurface(await import(pathToFileURL(resolve(root, 'dist/esm/index.js'))), 'esm');

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
  ['dist/esm/providers/mapbox/mapbox.config.d.ts', ['PlaceDetailsOptionsMap']],
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
await new Geocoding('mapbox', { accessToken: 't' }).placeDetails({ placeId: 'p', sessionToken: 't' });`,
  // expectError: HERE has no isochrone augmentation, so it must stay at the
  // two-value base and reject 'cycling'.
  'here-isochrone.expectError.ts': `import { Isochrone } from '@thinwrap/location';
await new Isochrone('here', { apiKey: 'k' }).isochrone({
  center: { lat: 1, lng: 2 }, type: 'time', values: [300], travelMode: 'cycling' });`,
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
