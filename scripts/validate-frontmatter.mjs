#!/usr/bin/env node
/**
 * Per-connector README frontmatter validator — location scope.
 *
 * Reads every `src/providers/<id>/README.md`, parses the single leading YAML
 * frontmatter block at the top of the file (`providerId` plus an `operations:` map
 * keyed by operation — one entry per operation the provider supports), and validates
 * required keys and value shapes against the schema documented in
 * `schemas/connector-readme-schema.yaml`. Exits 0 on success, 1 with
 * line-prefixed errors on any failure. `--expected-blocks` counts total operations
 * across all READMEs.
 *
 * Wired into the CI lint-gates job. Standalone (no runtime deps) so it can
 * run pre-commit too.
 *
 * Usage:
 *   node scripts/validate-frontmatter.mjs
 *   node scripts/validate-frontmatter.mjs --expected-blocks 21
 *   node scripts/validate-frontmatter.mjs --expected-providers 6
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROVIDERS_DIR = join(REPO_ROOT, 'src', 'providers');

const args = process.argv.slice(2);
function readArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 ? Number(args[idx + 1]) : fallback;
}
const EXPECTED_BLOCKS = readArg('--expected-blocks', 21);
const EXPECTED_PROVIDERS = readArg('--expected-providers', 6);

// --- minimal YAML parser scoped to the frontmatter shape we accept ---
// Supports: scalar keys, nested objects (2-space indent), arrays of scalars,
// quoted and unquoted strings, booleans, integers, and the YAML literal
// block scalar (`|`) used by `notes_passthrough`.
function parseFrontmatter(text) {
  const lines = text.split('\n');
  const root = {};
  let i = 0;

  function parseBlock(indent) {
    const obj = {};
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const currentIndent = raw.match(/^ */)[0].length;
      if (currentIndent < indent) return obj;
      if (currentIndent > indent) {
        throw new Error(`Unexpected indent at line ${i + 1}: "${raw}"`);
      }
      const line = raw.slice(indent);
      if (line.startsWith('- ')) return obj;

      const colon = line.indexOf(':');
      if (colon === -1) {
        throw new Error(`Expected key:value at line ${i + 1}: "${raw}"`);
      }
      const key = line.slice(0, colon).trim();
      const rest = line.slice(colon + 1).trim();
      i += 1;

      if (rest === '') {
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        if (j >= lines.length) {
          obj[key] = null;
          continue;
        }
        const peek = lines[j];
        const peekIndent = peek.match(/^ */)[0].length;
        if (peekIndent <= indent) {
          obj[key] = null;
          continue;
        }
        const peekLine = peek.slice(peekIndent);
        if (peekLine.startsWith('- ')) {
          obj[key] = parseArray(peekIndent);
        } else {
          obj[key] = parseBlock(peekIndent);
        }
      } else if (rest === '|') {
        const blockIndent = indent + 2;
        const collected = [];
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trim() === '') {
            collected.push('');
            i += 1;
            continue;
          }
          const blIndent = bl.match(/^ */)[0].length;
          if (blIndent < blockIndent) break;
          collected.push(bl.slice(blockIndent));
          i += 1;
        }
        obj[key] = collected.join('\n').replace(/\n+$/, '');
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        const inner = rest.slice(1, -1).trim();
        obj[key] = inner === '' ? [] : inner.split(',').map((s) => coerceScalar(s.trim()));
      } else {
        obj[key] = coerceScalar(rest);
      }
    }
    return obj;
  }

  function parseArray(indent) {
    const arr = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const currentIndent = raw.match(/^ */)[0].length;
      if (currentIndent < indent) return arr;
      const line = raw.slice(indent);
      if (!line.startsWith('- ')) return arr;
      const item = line.slice(2).trim();
      arr.push(coerceScalar(item));
      i += 1;
    }
    return arr;
  }

  function coerceScalar(s) {
    if (s === '' || s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.match(/^ */)[0].length;
    Object.assign(root, parseBlock(indent));
    break;
  }
  while (i < lines.length) {
    Object.assign(root, parseBlock(0));
    const before = i;
    if (i === before) i += 1;
  }
  return root;
}

/**
 * Location READMEs carry ONE leading YAML frontmatter block at the very top of
 * the file (opening `---` on line 1, so GitHub renders it as real frontmatter),
 * with every operation keyed under `operations:`. Extract that single block:
 * scan to the first `---`, parse through the matching close. A leading `# title`
 * before the block (if any) is skipped; markdown thematic-break `---` separators
 * later in the body are not part of the block.
 */
function extractLeadingFrontmatter(content, file) {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() !== '---') i += 1;
  if (i >= lines.length) return null;
  const startLine = i + 1;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== '---') j += 1;
  if (j >= lines.length) {
    throw new Error(
      `${file}: unterminated frontmatter block starting at line ${startLine}`,
    );
  }
  const yamlText = lines.slice(i + 1, j).join('\n');
  return { startLine, meta: parseFrontmatter(yamlText) };
}

// --- schema validation ---
const AUTH_METHODS = new Set([
  'api-key-header',
  'api-key-query',
  'api-key-form',
  'bearer',
  'arcgis-token',
  'oauth2-client-credentials',
  'none',
]);
const TOKEN_LIFECYCLES = new Set(['static', 'rotating', 'refreshable', 'none']);
const OPERATIONS = new Set(['routing', 'matrix', 'geocoding', 'isochrone']);
// Required at the top level of the single leading frontmatter block.
const REQUIRED_TOP = ['providerId', 'operations'];
// Required inside each operation object (the value under operations.<op>).
const REQUIRED_OP = [
  'auth',
  'endpoint',
  'versioning',
  'selfHostable',
  'notes_passthrough',
];

/** Validate one operation's metadata — the object under `operations.<op>`. */
function validateOperation(meta, file, blockLine, op) {
  const errors = [];
  const prefix = `${file}:${blockLine} (operation '${op}')`;
  for (const key of REQUIRED_OP) {
    if (!(key in meta) || meta[key] === null || meta[key] === undefined) {
      errors.push(`${prefix}: missing required key '${key}'`);
    }
  }
  if (meta.auth && typeof meta.auth === 'object') {
    for (const k of ['method', 'tokenLifecycle']) {
      if (!(k in meta.auth)) {
        errors.push(`${prefix}: auth.${k} is required`);
      }
    }
    if (meta.auth.method && !AUTH_METHODS.has(meta.auth.method)) {
      errors.push(
        `${prefix}: auth.method '${meta.auth.method}' must be one of ${[...AUTH_METHODS].join(', ')}`,
      );
    }
    if (
      meta.auth.tokenLifecycle &&
      !TOKEN_LIFECYCLES.has(meta.auth.tokenLifecycle)
    ) {
      errors.push(
        `${prefix}: auth.tokenLifecycle '${meta.auth.tokenLifecycle}' must be one of ${[...TOKEN_LIFECYCLES].join(', ')}`,
      );
    }
  }
  if (meta.endpoint && typeof meta.endpoint === 'object') {
    if (!meta.endpoint.default) {
      errors.push(`${prefix}: endpoint.default is required`);
    } else if (
      typeof meta.endpoint.default !== 'string' ||
      !/^https?:\/\//.test(meta.endpoint.default)
    ) {
      errors.push(
        `${prefix}: endpoint.default must be an http(s) URL (got '${meta.endpoint.default}')`,
      );
    }
  }
  if (meta.versioning && typeof meta.versioning === 'object') {
    if (!meta.versioning.vendorApiVersion) {
      errors.push(`${prefix}: versioning.vendorApiVersion is required`);
    }
    if (!meta.versioning.lastVerified) {
      errors.push(`${prefix}: versioning.lastVerified is required`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.versioning.lastVerified))) {
      errors.push(
        `${prefix}: versioning.lastVerified '${meta.versioning.lastVerified}' must be ISO date YYYY-MM-DD`,
      );
    }
  }
  if ('selfHostable' in meta && typeof meta.selfHostable !== 'boolean') {
    errors.push(`${prefix}: selfHostable must be a boolean`);
  }
  if (
    'retryAfterSurfaced' in meta &&
    typeof meta.retryAfterSurfaced !== 'boolean'
  ) {
    errors.push(`${prefix}: retryAfterSurfaced must be a boolean`);
  }
  if (
    'notes_passthrough' in meta &&
    typeof meta.notes_passthrough !== 'string'
  ) {
    errors.push(`${prefix}: notes_passthrough must be a string`);
  }
  return errors;
}

function listProviderReadmes() {
  const entries = readdirSync(PROVIDERS_DIR, { withFileTypes: true });
  const readmes = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const readme = join(PROVIDERS_DIR, e.name, 'README.md');
    try {
      const s = statSync(readme);
      if (s.isFile()) readmes.push({ id: e.name, path: readme });
    } catch {
      readmes.push({ id: e.name, path: readme, missing: true });
    }
  }
  return readmes;
}

function main() {
  const readmes = listProviderReadmes();
  const errors = [];

  const present = readmes.filter((r) => !r.missing);
  const missing = readmes.filter((r) => r.missing);
  for (const m of missing) {
    errors.push(`${m.path}: missing per-connector README`);
  }

  let totalBlocks = 0;
  for (const r of present) {
    const content = readFileSync(r.path, 'utf8');
    try {
      const block = extractLeadingFrontmatter(content, r.path);
      if (block === null) {
        errors.push(`${r.path}: contains no YAML frontmatter block`);
        continue;
      }
      const { startLine: line, meta } = block;
      const prefix = `${r.path}:${line}`;

      for (const key of REQUIRED_TOP) {
        if (!(key in meta) || meta[key] === null || meta[key] === undefined) {
          errors.push(`${prefix}: missing required key '${key}'`);
        }
      }
      if (meta.providerId) {
        if (!/^[a-z][a-z0-9-]*$/.test(meta.providerId)) {
          errors.push(
            `${prefix}: providerId '${meta.providerId}' must match /^[a-z][a-z0-9-]*$/`,
          );
        }
        if (meta.providerId !== r.id) {
          errors.push(
            `${prefix}: providerId '${meta.providerId}' does not match directory name '${r.id}'`,
          );
        }
      }
      const ops = meta.operations;
      if (ops && typeof ops === 'object' && Object.keys(ops).length > 0) {
        for (const [op, opMeta] of Object.entries(ops)) {
          if (!OPERATIONS.has(op)) {
            errors.push(
              `${prefix}: operation '${op}' must be one of ${[...OPERATIONS].join(', ')}`,
            );
          }
          if (!opMeta || typeof opMeta !== 'object') {
            errors.push(`${prefix}: operations.${op} must be a mapping`);
            continue;
          }
          totalBlocks += 1;
          errors.push(...validateOperation(opMeta, r.path, line, op));
        }
      } else if ('operations' in meta) {
        errors.push(
          `${prefix}: operations must be a non-empty mapping of operation → metadata`,
        );
      }
    } catch (e) {
      errors.push(`${r.path}: ${e.message}`);
    }
  }

  const totalProviders = present.length;
  if (Number.isFinite(EXPECTED_PROVIDERS) && totalProviders !== EXPECTED_PROVIDERS) {
    errors.push(
      `coverage: found ${totalProviders} per-connector README(s); expected ${EXPECTED_PROVIDERS}`,
    );
  }
  if (Number.isFinite(EXPECTED_BLOCKS) && totalBlocks !== EXPECTED_BLOCKS) {
    errors.push(
      `coverage: found ${totalBlocks} frontmatter block(s) across all READMEs; expected ${EXPECTED_BLOCKS}`,
    );
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} error(s) — frontmatter validation failed.`);
    process.exit(1);
  }
  console.log(
    `OK — ${totalProviders} per-connector README(s) / ${totalBlocks} frontmatter block(s) validated against schemas/connector-readme-schema.yaml`,
  );
}

main();
