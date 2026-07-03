import { describe, it, expect } from 'vitest';
import { mergePassthrough } from './merge-passthrough';

describe('mergePassthrough', () => {
  it('returns identity merge when no passthrough provided', () => {
    const result = mergePassthrough({ a: 1 }, { 'X-H': 'v' }, undefined, { q: 'k' });
    expect(result.body).toEqual({ a: 1 });
    expect(result.headers).toEqual({ 'X-H': 'v' });
    expect(result.query).toEqual({ q: 'k' });
  });

  it('deep-merges nested body objects', () => {
    const connectorBody = { outer: { a: 1, b: 2 }, top: 'keep' };
    const result = mergePassthrough(connectorBody, {}, {
      body: { outer: { b: 99, c: 3 }, top: 'overwritten' },
    });
    expect(result.body).toEqual({
      outer: { a: 1, b: 99, c: 3 },
      top: 'overwritten',
    });
  });

  it('replaces arrays last-write-wins (no array merge)', () => {
    const result = mergePassthrough({ list: [1, 2, 3] }, {}, { body: { list: [4] } });
    expect(result.body).toEqual({ list: [4] });
  });

  it('shallow-merges headers, last-write-wins', () => {
    const result = mergePassthrough({}, { 'X-A': '1', 'X-B': '2' }, {
      headers: { 'X-B': '99', 'X-C': '3' },
    });
    expect(result.headers).toEqual({ 'X-A': '1', 'X-B': '99', 'X-C': '3' });
  });

  it('shallow-merges query, last-write-wins', () => {
    const result = mergePassthrough({}, {}, { query: { b: '99', c: '3' } }, { a: '1', b: '2' });
    expect(result.query).toEqual({ a: '1', b: '99', c: '3' });
  });

  it('undefined source values do not overwrite target', () => {
    const result = mergePassthrough({ a: 1, b: 2 }, {}, {
      body: { a: undefined as unknown as number, b: 99 },
    });
    expect(result.body).toEqual({ a: 1, b: 99 });
  });

  it('treats Buffer as opaque (not deep-merged) when running on Node', () => {
    if (typeof Buffer === 'undefined') return;
    const buf1 = Buffer.from('hello');
    const buf2 = Buffer.from('world');
    const result = mergePassthrough({ payload: buf1 } as Record<string, unknown>, {}, {
      body: { payload: buf2 },
    });
    expect(result.body.payload).toBe(buf2);
  });

  it('returns all three keys even when passthrough is empty object', () => {
    const result = mergePassthrough({ a: 1 }, {}, {});
    expect(result).toEqual({ body: { a: 1 }, headers: {}, query: {} });
  });
});
