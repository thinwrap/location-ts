import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseConnector } from './base.connector';
import { ConnectorError } from '../types/error.types';

class TestConnector extends BaseConnector {
  readonly providerId = 'test';

  constructor(fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  callGet(url: string, opts?: { headers?: Record<string, string>; query?: Record<string, string> }) {
    return this.sendGet(url, opts);
  }
  callPostJson(url: string, body: unknown, opts?: { headers?: Record<string, string>; query?: Record<string, string> }) {
    return this.sendPostJson(url, body, opts);
  }
  callPostForm(url: string, form: Record<string, string>, opts?: { headers?: Record<string, string>; query?: Record<string, string> }) {
    return this.sendPostForm(url, form, opts);
  }
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BaseConnector', () => {
  describe('sendGet', () => {
    it('issues GET without query when none provided', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callGet('https://api.example.com/x');
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.example.com/x');
      expect(init?.method).toBe('GET');
    });

    it('appends query-string when query provided', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callGet('https://api.example.com/x', { query: { a: '1', b: '2' } });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toMatch(/^https:\/\/api\.example\.com\/x\?/);
      expect(url).toContain('a=1');
      expect(url).toContain('b=2');
    });

    it('passes through headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callGet('https://api.example.com/x', { headers: { 'X-Foo': 'bar' } });
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init?.headers).toEqual({ 'X-Foo': 'bar' });
    });
  });

  describe('sendPostJson', () => {
    it('issues POST with Content-Type: application/json and JSON body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callPostJson('https://api.example.com/x', { hello: 'world' });
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.example.com/x');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ hello: 'world' }));
    });

    it('merges caller headers without removing Content-Type default', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callPostJson('https://api.example.com/x', {}, { headers: { Authorization: 'Bearer t' } });
      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer t');
    });

    it('appends query-string when query provided', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callPostJson('https://api.example.com/x', {}, { query: { k: 'v' } });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.example.com/x?k=v');
    });
  });

  describe('sendPostForm', () => {
    it('issues POST with x-www-form-urlencoded body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callPostForm('https://api.example.com/x', { a: '1', b: '2' });
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init?.body).toBe('a=1&b=2');
    });
  });

  describe('invokeFetch network-error wrap', () => {
    it('wraps a fetch rejection as ConnectorError with statusCode:null + provider_unavailable', async () => {
      const netErr = new TypeError('fetch failed');
      mockFetch.mockRejectedValueOnce(netErr);
      const c = new TestConnector();
      await expect(c.callGet('https://api.example.com/x')).rejects.toMatchObject({
        name: 'ConnectorError',
        statusCode: null,
        providerCode: 'provider_unavailable',
      });
    });

    it('attaches the original error as cause', async () => {
      const netErr = new TypeError('boom');
      mockFetch.mockRejectedValueOnce(netErr);
      const c = new TestConnector();
      let thrown: unknown;
      try {
        await c.callGet('https://api.example.com/x');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).cause).toBe(netErr);
    });
  });

  describe('fetchImpl injection', () => {
    it('uses injected fetchImpl when provided', async () => {
      const customFetch = vi.fn().mockResolvedValue(new Response('custom'));
      const c = new TestConnector(customFetch);
      await c.callGet('https://api.example.com/x');
      expect(customFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls back to globalThis.fetch when no fetchImpl provided', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok'));
      const c = new TestConnector();
      await c.callGet('https://api.example.com/x');
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });
});
