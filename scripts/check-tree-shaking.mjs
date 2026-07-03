#!/usr/bin/env node
/**
 * — Tree-shaking spot-check.
 *
 * For 4 representative connectors, bundle each as a single-import esbuild
 * output and assert NONE of a hand-picked set of other connectors' class
 * identifiers appear in the bundle.
 *
 * The probes cover both failure-mode boundaries: cross-provider (e.g. a
 * Google import must not drag in Mapbox/HERE) and cross-operation within a
 * provider (e.g. an Esri geocoding import must not drag in Esri routing —
 * the SigV4 path lives there). Spot-checking 4 (not all 21) covers those
 * boundaries; the full per-connector ceiling is enforced by `size-limit`
 * (see `.size-limit.json`).
 *
 * Run after `npm run build`. Exits 0 on success, 1 on any cross-provider
 * identifier hit.
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// Spot-check probes: pick representative connectors; list cross-provider /
// cross-operation class identifiers that MUST NOT appear in the bundle.
const PROBES = [
  {
    name: 'google-routing',
    importName: 'GoogleRoutingConnector',
    forbidden: [
      'MapboxRoutingConnector',
      'HereRoutingConnector',
      'OsrmRoutingConnector',
      'GoogleGeocodingConnector',
      'EsriMatrixConnector',
    ],
  },
  {
    name: 'osrm-routing',
    importName: 'OsrmRoutingConnector',
    forbidden: [
      'GoogleRoutingConnector',
      'TomTomRoutingConnector',
      'HereMatrixConnector',
      'MapboxIsochroneConnector',
      'EsriGeocodingConnector',
    ],
  },
  {
    name: 'mapbox-isochrone',
    importName: 'MapboxIsochroneConnector',
    forbidden: [
      'HereIsochroneConnector',
      'TomTomIsochroneConnector',
      'MapboxRoutingConnector',
      'GoogleMatrixConnector',
      'EsriRoutingConnector',
    ],
  },
  {
    name: 'esri-geocoding',
    importName: 'EsriGeocodingConnector',
    forbidden: [
      'GoogleGeocodingConnector',
      'HereGeocodingConnector',
      'MapboxGeocodingConnector',
      'TomTomGeocodingConnector',
      'EsriRoutingConnector',
    ],
  },
];

const root = new URL('..', import.meta.url).pathname;
const entryDist = join(root, 'dist', 'esm', 'index.js');

let mismatches = 0;

for (const probe of PROBES) {
  const dir = await mkdtemp(join(tmpdir(), `thinwrap-treeshake-${probe.name}-`));
  const entryFile = join(dir, 'entry.mjs');
  const outFile = join(dir, 'bundle.js');
  try {
    await writeFile(
      entryFile,
      `import { ${probe.importName} } from '${entryDist}';\nconsole.log(${probe.importName}.name);\n`,
      'utf8',
    );
    await build({
      entryPoints: [entryFile],
      bundle: true,
      minify: false,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outFile,
      logLevel: 'silent',
    });
    const bundle = await readFile(outFile, 'utf8');
    for (const ident of probe.forbidden) {
      // Use word boundary regex to avoid matching substrings.
      const re = new RegExp(`\\b${ident}\\b`);
      if (re.test(bundle)) {
        mismatches += 1;
        console.error(
          `tree-shaking regression: ${probe.name} bundle contains ${ident}`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (mismatches === 0) {
  console.log(
    `OK — ${PROBES.length} spot-checks passed (no cross-provider identifiers in single-import bundles).`,
  );
  process.exit(0);
}
console.error(`FAIL — ${mismatches} cross-provider identifier(s) detected.`);
process.exit(1);
