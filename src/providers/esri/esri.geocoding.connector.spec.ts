import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriGeocodingConnector } from './esri.geocoding.connector';
import type { EsriConfig } from './esri.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: EsriConfig = { apiKey: 'esri-test-token' };

const GEOCODE_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const REVGEOCODE_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode';
const SUGGEST_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest';

function buildForwardCandidatesResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function buildForwardBody(
  candidates: Array<{
    address: string;
    location: { x: number; y: number };
    extent?: { xmin: number; ymin: number; xmax: number; ymax: number };
  }>,
): Record<string, unknown> {
  return { candidates };
}

function buildReverseBody(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function buildSuggestResponseBody(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function urlOf(call: unknown[]): string {
  return call[0] as string;
}

describe('EsriGeocodingConnector', () => {
  let connector: EsriGeocodingConnector;

  beforeEach(() => {
    connector = new EsriGeocodingConnector(defaultConfig);
  });

  it('exposes providerId "esri"', () => {
    expect(connector.providerId).toBe('esri');
  });

  // -------------------------------------------------------------------------
  // forward geocode
  // -------------------------------------------------------------------------
  describe('forward geocode', () => {
    it('GETs findAddressCandidates with singleLine, outFields=*, and token', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(
          buildForwardBody([
            {
              address: '380 New York St, Redlands, CA 92373',
              location: { x: -117.1956, y: 34.0572 },
            },
          ]),
        ),
      );

      const result = await connector.geocode({ address: '380 New York St' });

      const [url, init] = mockFetch.mock.calls[0]!;
      const u = url as string;
      expect(u.split('?')[0]).toBe(GEOCODE_URL);
      expect(init?.method).toBe('GET');
      expect(u).toContain('singleLine=380');
      // '*' is unreserved in application/x-www-form-urlencoded so URLSearchParams
      // emits it raw. ESRI accepts both `*` and `%2A`.
      expect(u).toContain('outFields=*');
      expect(u).toContain('token=esri-test-token');
      expect(u).toContain('f=json');

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        formattedAddress: '380 New York St, Redlands, CA 92373',
        location: { lat: 34.0572, lng: -117.1956 },
      });
      // placeId is `undefined` for forward geocode (no stable per-result ID).
      expect(result.candidates[0]!.placeId).toBeUndefined();
    });

    it('forwards countryFilter as comma-joined alpha-2 in `countryCode`', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({
        address: '1600 Pennsylvania Ave',
        countryFilter: ['US', 'CA'],
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('countryCode=US%2CCA');
    });

    it('omits countryCode when countryFilter is undefined or empty', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({
        address: 'foo',
        countryFilter: [],
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).not.toContain('countryCode=');
    });

    it('returns multi-result candidates[] (forward is natively multi-result)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(
          buildForwardBody([
            {
              address: 'A',
              location: { x: 1, y: 2 },
            },
            {
              address: 'B',
              location: { x: 3, y: 4 },
            },
          ]),
        ),
      );

      const result = await connector.geocode({ address: 'multi' });
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]!.formattedAddress).toBe('A');
      expect(result.candidates[1]!.location).toEqual({ lat: 4, lng: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // forward response normalization (incl. viewport from extent)
  // -------------------------------------------------------------------------
  describe('forward response normalization', () => {
    it('translates ESRI extent {xmin,ymin,xmax,ymax} → viewport {southwest,northeast}', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(
          buildForwardBody([
            {
              address: '380 New York St, Redlands, CA 92373',
              location: { x: -117.1956, y: 34.0572 },
              extent: {
                xmin: -117.2,
                ymin: 34.05,
                xmax: -117.19,
                ymax: 34.06,
              },
            },
          ]),
        ),
      );

      const result = await connector.geocode({ address: '380 New York St' });
      expect(result.candidates[0]!.viewport).toEqual({
        southwest: { lat: 34.05, lng: -117.2 },
        northeast: { lat: 34.06, lng: -117.19 },
      });
    });

    it('omits viewport when extent is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(
          buildForwardBody([
            {
              address: 'A',
              location: { x: 0, y: 0 },
            },
          ]),
        ),
      );

      const result = await connector.geocode({ address: 'A' });
      expect(result.candidates[0]!.viewport).toBeUndefined();
    });

    it('exposes the raw vendor body in result.raw', async () => {
      const body = buildForwardBody([
        { address: 'A', location: { x: 0, y: 0 } },
      ]);
      mockFetch.mockResolvedValueOnce(buildForwardCandidatesResponse(body));
      const result = await connector.geocode({ address: 'A' });
      expect(result.raw).toMatchObject(body);
    });
  });

  // -------------------------------------------------------------------------
  // reverse geocode + single-result wrap
  // -------------------------------------------------------------------------
  describe('reverse geocode + single-result wrap', () => {
    it('GETs reverseGeocode with location=<lng>,<lat> (ESRI lng-first)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildReverseBody({
          address: { LongLabel: '380 New York St, Redlands, CA 92373' },
          location: { x: -117.1956, y: 34.0572 },
        }),
      );

      await connector.reverseGeocode({
        location: { lat: 34.0572, lng: -117.1956 },
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u.split('?')[0]).toBe(REVGEOCODE_URL);
      expect(u).toContain('location=-117.1956%2C34.0572');
    });

    it('wraps the single ESRI result into a one-element candidates[]', async () => {
      mockFetch.mockResolvedValueOnce(
        buildReverseBody({
          address: { LongLabel: '380 New York St, Redlands, CA 92373' },
          location: { x: -117.1956, y: 34.0572 },
        }),
      );

      const result = await connector.reverseGeocode({
        location: { lat: 34.0572, lng: -117.1956 },
      });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toEqual({
        formattedAddress: '380 New York St, Redlands, CA 92373',
        location: { lat: 34.0572, lng: -117.1956 },
      });
      // placeId undefined (no stable ID on reverseGeocode result).
      expect(result.candidates[0]!.placeId).toBeUndefined();
      // viewport undefined (reverseGeocode has no extent).
      expect(result.candidates[0]!.viewport).toBeUndefined();
    });

    it('falls back to Match_addr when LongLabel is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildReverseBody({
          address: { Match_addr: '380 New York St' },
          location: { x: -117.1956, y: 34.0572 },
        }),
      );

      const result = await connector.reverseGeocode({
        location: { lat: 34.0572, lng: -117.1956 },
      });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.formattedAddress).toBe('380 New York St');
    });

    it('returns an empty candidates[] when ESRI returns no address payload', async () => {
      mockFetch.mockResolvedValueOnce(buildReverseBody({}));

      const result = await connector.reverseGeocode({
        location: { lat: 0, lng: 0 },
      });

      expect(result.candidates).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // autocomplete: magicKey → placeId; radius + language no-ops
  // -------------------------------------------------------------------------
  describe('autocomplete', () => {
    it('GETs suggest with text + token', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuggestResponseBody({
          suggestions: [
            { text: 'New York, NY', magicKey: 'mk1', isCollection: false },
          ],
        }),
      );

      await connector.autocomplete({ input: 'New York' });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u.split('?')[0]).toBe(SUGGEST_URL);
      expect(u).toContain('text=New+York');
      expect(u).toContain('token=esri-test-token');
    });

    it('maps each suggestion.magicKey → prediction.placeId', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuggestResponseBody({
          suggestions: [
            { text: 'New York, NY', magicKey: 'mk1', isCollection: false },
            { text: 'New York Mills, MN', magicKey: 'mk2', isCollection: false },
          ],
        }),
      );

      const result = await connector.autocomplete({ input: 'New York' });

      expect(result.predictions).toEqual([
        { description: 'New York, NY', placeId: 'mk1' },
        { description: 'New York Mills, MN', placeId: 'mk2' },
      ]);
    });

    it('forwards location bias as `location=<lng>,<lat>` when supplied', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuggestResponseBody({ suggestions: [] }),
      );

      await connector.autocomplete({
        input: 'foo',
        location: { lat: 34.0572, lng: -117.1956 },
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('location=-117.1956%2C34.0572');
    });

    it('treats `radius` as a documented no-op (does not emit a wire param)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuggestResponseBody({ suggestions: [] }),
      );

      await connector.autocomplete({ input: 'foo', radius: 5000 });

      const u = urlOf(mockFetch.mock.calls[0]!);
      // ESRI /suggest has no first-class radius parameter; not surfaced.
      expect(u).not.toContain('radius=');
    });

    it('treats `language` as a documented no-op (does not emit a wire param)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuggestResponseBody({ suggestions: [] }),
      );

      await connector.autocomplete({ input: 'foo', language: 'en' });

      const u = urlOf(mockFetch.mock.calls[0]!);
      // ESRI /suggest has no per-request language flag; not surfaced.
      expect(u).not.toContain('langCode=');
      expect(u).not.toContain('language=');
    });
  });

  // -------------------------------------------------------------------------
  // auth handling (dual-auth XOR via resolveEsriBearerToken)
  // -------------------------------------------------------------------------
  describe('auth handling', () => {
    it('forwards apiKey via the `token` query param', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({ address: 'foo' });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('token=esri-test-token');
    });

    it('forwards arcgisToken via the same `token` query param when set instead', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      const c = new EsriGeocodingConnector({ arcgisToken: 'oauth-bearer' });
      await c.geocode({ address: 'foo' });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('token=oauth-bearer');
    });

    it('throws invalid_request when both apiKey and arcgisToken are set (XOR)', async () => {
      const c = new EsriGeocodingConnector({
        apiKey: 'a',
        arcgisToken: 'b',
      });

      let thrown: unknown;
      try {
        await c.geocode({ address: 'foo' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws auth_failed when neither apiKey nor arcgisToken is set', async () => {
      const c = new EsriGeocodingConnector({});

      let thrown: unknown;
      try {
        await c.geocode({ address: 'foo' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('auth_failed');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // mapVendorError + 200-with-error-body
  // -------------------------------------------------------------------------
  describe('mapVendorError', () => {
    const httpCases: Array<{ status: number; expected: string }> = [
      { status: 400, expected: 'invalid_request' },
      { status: 401, expected: 'auth_failed' },
      { status: 403, expected: 'auth_failed' },
      { status: 429, expected: 'rate_limited' },
      { status: 500, expected: 'provider_unavailable' },
      { status: 503, expected: 'provider_unavailable' },
      { status: 418, expected: 'unknown' },
    ];

    for (const c of httpCases) {
      it(`HTTP ${c.status} → ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'fail' }), {
            status: c.status,
          }),
        );
        let thrown: unknown;
        try {
          await connector.geocode({ address: 'foo' });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConnectorError);
        expect((thrown as ConnectorError).statusCode).toBe(c.status);
        expect((thrown as ConnectorError).providerCode).toBe(c.expected);
      });
    }

    const bodyCases: Array<{ code: number; expected: string }> = [
      { code: 498, expected: 'auth_failed' },
      { code: 499, expected: 'auth_failed' },
      { code: 403, expected: 'auth_failed' },
      { code: 400, expected: 'invalid_request' },
      { code: 404, expected: 'invalid_request' },
      { code: 500, expected: 'provider_unavailable' },
      { code: 12345, expected: 'unknown' },
    ];

    for (const c of bodyCases) {
      it(`200-with-error-body code ${c.code} → ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'fail', code: c.code } }),
            { status: 200 },
          ),
        );
        let thrown: unknown;
        try {
          await connector.geocode({ address: 'foo' });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConnectorError);
        expect((thrown as ConnectorError).providerCode).toBe(c.expected);
        expect((thrown as ConnectorError).statusCode).toBe(200);
      });
    }

    // Esri 429-precedence regression: a genuine HTTP 429 must classify as
    // rate_limited EVEN when the body carries an error code that would
    // otherwise fall through to the generic 'unknown' mapping. (Previously the
    // in-body branch short-circuited and returned 'unknown' before the 429
    // status check was reached.)
    it('HTTP 429 with a generic in-body error code → rate_limited (429-precedence)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Too Many Requests', code: 12345 } }),
          { status: 429 },
        ),
      );
      let thrown: unknown;
      try {
        await connector.geocode({ address: 'foo' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).statusCode).toBe(429);
      expect((thrown as ConnectorError).providerCode).toBe('rate_limited');
    });

    it('HTTP 429 with no in-body error code → rate_limited (429-precedence)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
        }),
      );
      let thrown: unknown;
      try {
        await connector.geocode({ address: 'foo' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('rate_limited');
    });

    it('surfaces Retry-After in providerMessage and cause by design', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Too Many Requests', code: 429 },
          }),
          { status: 429, headers: { 'Retry-After': '42' } },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.geocode({ address: 'foo' });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerMessage).toContain('retry after 42 seconds');
      expect(thrown!.providerMessage).toContain('Too Many Requests');
      const cause = thrown!.cause as Record<string, unknown> | undefined;
      expect(cause?.retryAfter).toBe('42');
      // No structured retryAfterSeconds field per feedback memory.
      expect(
        (thrown as unknown as Record<string, unknown>).retryAfterSeconds,
      ).toBeUndefined();
    });

    it('200-with-error-body fires for reverseGeocode as well', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid token', code: 498 },
          }),
          { status: 200 },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.reverseGeocode({
          location: { lat: 0, lng: 0 },
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('auth_failed');
      expect(thrown!.statusCode).toBe(200);
    });

    it('200-with-error-body fires for autocomplete as well', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid token', code: 498 },
          }),
          { status: 200 },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.autocomplete({ input: 'foo' });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('auth_failed');
      expect(thrown!.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // _passthrough merging (3-arg mergePassthrough)
  // -------------------------------------------------------------------------
  describe('_passthrough merging', () => {
    it('merges _passthrough.query into the request URL', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({
        address: 'foo',
        _passthrough: { query: { trace: 'on' } },
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('trace=on');
    });

    it('merges _passthrough.headers into the request headers', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({
        address: 'foo',
        _passthrough: { headers: { 'X-Custom': 'value' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
    });

    it('merges _passthrough.body fields into the query string (GET projection)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildForwardCandidatesResponse(buildForwardBody([])),
      );

      await connector.geocode({
        address: 'foo',
        _passthrough: { body: { category: 'Address' } },
      });

      const u = urlOf(mockFetch.mock.calls[0]!);
      expect(u).toContain('category=Address');
    });
  });
});
