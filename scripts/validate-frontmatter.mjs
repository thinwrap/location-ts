#!/usr/bin/env node
/**
 * Per-connector README frontmatter validator — location scope.
 *
 * Reads every `src/providers/<id>/README.md`, parses ALL leading YAML
 * frontmatter blocks (each delimited by `---` markers; location scope uses
 * one block per operation within a single per-provider file), and validates
 * required keys and value shapes against the schema documented in
 * `schemas/connector-readme-schema.yaml`. Exits 0 on success, 1 with
 * line-prefixed errors on any failure.
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
 * Extract every YAML frontmatter block in a markdown file. Each block is
 * delimited by `---` on its own line at the start, with a closing `---`
 * sometime later. We scan the entire file (location scope uses multiple
 * blocks per file, one per operation section).
 */
/**
 * A "frontmatter block" is an opening `---` line followed (after optional
 * blank lines) by at least one YAML mapping key (`<word>:`) and closed by
 * another `---` line. `---` lines that are NOT followed by a YAML mapping
 * (e.g. markdown thematic-break separators between sections) are skipped.
 */
function looksLikeYamlMappingStart(line) {
  // A non-indented `key:` line, optionally followed by a value. Reject
  // markdown headings, list items, code fences, and table dividers.
  if (line.length === 0) return false;
  if (/^[-*#`>|]/.test(line)) return false;
  return /^[A-Za-z_][A-Za-z0-9_-]*\s*:(\s.*)?$/.test(line);
}

function extractFrontmatterBlocks(content, file) {
  const blocks = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '---') {
      // Peek the next non-blank line. If it looks like a YAML mapping start,
      // we have a frontmatter block; otherwise this is a markdown separator.
      let p = i + 1;
      while (p < lines.length && lines[p].trim() === '') p += 1;
      if (p >= lines.length || !looksLikeYamlMappingStart(lines[p])) {
        i += 1;
        continue;
      }
      // Find closing delimiter — a `---` line.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---') j += 1;
      if (j >= lines.length) {
        throw new Error(
          `${file}: unterminated frontmatter block starting at line ${i + 1}`,
        );
      }
      const yamlText = lines.slice(i + 1, j).join('\n');
      blocks.push({
        startLine: i + 1,
        endLine: j + 1,
        meta: parseFrontmatter(yamlText),
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return blocks;
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
const REQUIRED_TOP = [
  'providerId',
  'operation',
  'auth',
  'endpoint',
  'versioning',
  'selfHostable',
  'notes_passthrough',
];

function validate(meta, file, blockLine) {
  const errors = [];
  const prefix = `${file}:${blockLine}`;
  for (const key of REQUIRED_TOP) {
    if (!(key in meta) || meta[key] === null || meta[key] === undefined) {
      errors.push(`${prefix}: missing required key '${key}'`);
    }
  }
  if (meta.providerId && !/^[a-z][a-z0-9-]*$/.test(meta.providerId)) {
    errors.push(
      `${prefix}: providerId '${meta.providerId}' must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  if (meta.operation && !OPERATIONS.has(meta.operation)) {
    errors.push(
      `${prefix}: operation '${meta.operation}' must be one of ${[...OPERATIONS].join(', ')}`,
    );
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
      const blocks = extractFrontmatterBlocks(content, r.path);
      if (blocks.length === 0) {
        errors.push(`${r.path}: contains no YAML frontmatter blocks`);
        continue;
      }
      totalBlocks += blocks.length;
      const seenOps = new Set();
      for (const block of blocks) {
        const errs = validate(block.meta, r.path, block.startLine);
        errors.push(...errs);
        if (block.meta.providerId && block.meta.providerId !== r.id) {
          errors.push(
            `${r.path}:${block.startLine}: providerId '${block.meta.providerId}' does not match directory name '${r.id}'`,
          );
        }
        if (block.meta.operation) {
          if (seenOps.has(block.meta.operation)) {
            errors.push(
              `${r.path}:${block.startLine}: duplicate operation '${block.meta.operation}' in same file`,
            );
          }
          seenOps.add(block.meta.operation);
        }
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
