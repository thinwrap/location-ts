import type { Passthrough } from '../types/passthrough.type';

export type MergedPassthrough<TBody = Record<string, unknown>> = {
  body: TBody;
  headers: Record<string, string>;
  query: Record<string, string>;
};

/**
 * Merge connector-built request parts with the consumer's `_passthrough`.
 *
 * The consumer's `_passthrough` intentionally OVERRIDES connector-set headers,
 * query params, and (deep-merged) body fields. This is a documented escape
 * hatch: there is deliberately NO reserved-key protection — a consumer can
 * override anything the connector sets (including auth headers) by design.
 */
export function mergePassthrough<TBody extends Record<string, unknown>>(
  connectorBody: TBody,
  connectorHeaders: Record<string, string> = {},
  passthrough?: Passthrough,
  connectorQuery: Record<string, string> = {},
): MergedPassthrough<TBody> {
  return {
    body: deepMergeBody(connectorBody, passthrough?.body ?? {}) as TBody,
    headers: { ...connectorHeaders, ...(passthrough?.headers ?? {}) },
    query: { ...connectorQuery, ...(passthrough?.query ?? {}) },
  };
}

function deepMergeBody(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const targetValue = result[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      result[key] = deepMergeBody(targetValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Treat ONLY plain objects (literals / `Object.create(null)`) as deep-mergeable.
 * Every other non-plain object — arrays, Buffer, typed arrays, ArrayBuffer,
 * streams, Date/Map/Set, and class instances — is scalar-replaced, never merged.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
