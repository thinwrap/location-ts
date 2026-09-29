import type { Passthrough } from '../types/passthrough.type';

/**
 * A connector-built query: an array value is a repeated key on the wire (see
 * `BaseConnector`'s `QueryParams`). A passthrough entry for the same key
 * replaces the whole array, like every other shallow-merged query key.
 */
export type ConnectorQuery = Record<string, string | readonly string[]>;

export type MergedPassthrough<
  TBody = Record<string, unknown>,
  TQuery extends ConnectorQuery = Record<string, string>,
> = {
  body: TBody;
  headers: Record<string, string>;
  query: TQuery;
};

/**
 * Merge connector-built request parts with the consumer's `_passthrough`.
 *
 * The consumer's `_passthrough` intentionally OVERRIDES connector-set headers,
 * query params, and (deep-merged) body fields. This is a documented escape
 * hatch: there is deliberately NO reserved-key protection — a consumer can
 * override anything the connector sets (including auth headers) by design.
 */
export function mergePassthrough<
  TBody extends Record<string, unknown>,
  TQuery extends ConnectorQuery = Record<string, string>,
>(
  connectorBody: TBody,
  connectorHeaders: Record<string, string> = {},
  passthrough?: Passthrough,
  connectorQuery: TQuery = {} as TQuery,
): MergedPassthrough<TBody, TQuery> {
  return {
    body: deepMergeBody(connectorBody, passthrough?.body ?? {}) as TBody,
    headers: mergeHeaders(connectorHeaders, passthrough?.headers),
    // Passthrough values are strings, which every `TQuery` value type admits.
    query: { ...connectorQuery, ...(passthrough?.query ?? {}) } as TQuery,
  };
}

/**
 * Overlay `override` onto `base`, matching header names case-insensitively.
 *
 * HTTP header names are case-insensitive, but a plain object spread is not: a
 * passthrough `x-goog-fieldmask` next to the connector's `X-Goog-FieldMask`
 * would survive as two keys, and fetch then joins them into one value
 * (`"mask-a, mask-b"`) that the vendor rejects or misreads. The override's key
 * replaces every differently-cased duplicate, and its spelling is the one sent.
 */
export function mergeHeaders(
  base: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(result)) {
      if (existing !== name && existing.toLowerCase() === lower) {
        delete result[existing];
      }
    }
    result[name] = value;
  }
  return result;
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
