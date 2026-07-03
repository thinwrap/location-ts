import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleGeocodingConnector } from './google.geocoding.connector';
import type { GoogleConfig } from './google.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: GoogleConfig = { apiKey: 'test-api-key' };

function buildGeocodeResponse(opts?: { withViewport?: boolean }) {
  return new Response(
    JSON.stringify({
      status: 'OK',
      results: [
        {
          formatted_address: '1600 Amphitheatre Parkway, Mountain View, CA',
          geometry: {
            location: { lat: 37.4224, lng: -122.0842 },
            ...(opts?.withViewport
              ? {
                  viewport: {
                    southwest: { lat: 37.42, lng: -122.09 },
                    northeast: { lat: 37.43, lng: -122.08 },
                  },
                }
              : {}),
          },
          place_id: 'ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
        },
      ],
    }),
    { status: 200 },
  );
}

function buildPlacesNewAutocompleteResponse() {
  return new Response(
    JSON.stringify({
      suggestions: [
        {
          placePrediction: {
            placeId: 'ChIJOwg_06VPwokRYv534QaPC8g',
            text: { text: 'New York, NY, USA' },
          },
        },
        {
          placePrediction: {
            placeId: 'abc123',
            text: { text: 'New York Mills, MN, USA' },
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function parseUrlParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.substring(q + 1) : '');
}

describe('GoogleGeocodingConnector', () => {
  let connector: GoogleGeocodingConnector;

  beforeEach(() => {
    connector = new GoogleGeocodingConnector(defaultConfig);
  });

  it('should have providerId "google"', () => {
    expect(connector.providerId).toBe('google');
  });

  describe('geocode', () => {
    it('should GET geocode endpoint with address and key', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      const result = await connector.geocode({
        address: '1600 Amphitheatre Parkway',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain('https://maps.googleapis.com/maps/api/geocode/json');
      expect(init?.method).toBe('GET');
      const params = parseUrlParams(url as string);
      expect(params.get('address')).toBe('1600 Amphitheatre Parkway');
      expect(params.get('key')).toBe('test-api-key');

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toEqual({
        formattedAddress: '1600 Amphitheatre Parkway, Mountain View, CA',
        location: { lat: 37.4224, lng: -122.0842 },
        placeId: 'ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
      });
    });

    // outlier translation — `countryFilter: ['US', 'CA']` becomes
    // Google's `components=country:US|country:CA` (pipe-separated key:value
    // pairs). Translation lives in the connector, NOT in shared utils.
    it('should translate countryFilter into components=country:XX|country:YY (outlier)', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      await connector.geocode({
        address: 'Springfield',
        countryFilter: ['US', 'CA'],
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('components')).toBe('country:US|country:CA');
    });

    it('should omit components when countryFilter is undefined or empty', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());
      await connector.geocode({ address: 'x' });
      const [url1] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(url1 as string).get('components')).toBeNull();

      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());
      await connector.geocode({ address: 'x', countryFilter: [] });
      const [url2] = mockFetch.mock.calls[1]!;
      expect(parseUrlParams(url2 as string).get('components')).toBeNull();
    });

    it('should include language when provided', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      await connector.geocode({ address: 'x', language: 'fr' });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('language')).toBe('fr');
    });

    // viewport is native on Google; promoted to base candidate shape.
    it('should populate viewport when Google returns one', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse({ withViewport: true }));

      const result = await connector.geocode({ address: 'x' });

      expect(result.candidates[0]!.viewport).toEqual({
        southwest: { lat: 37.42, lng: -122.09 },
        northeast: { lat: 37.43, lng: -122.08 },
      });
    });

    it('should return empty candidates[] on body.status === ZERO_RESULTS', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'ZERO_RESULTS', results: [] }),
          { status: 200 },
        ),
      );

      const result = await connector.geocode({ address: 'nowhere' });
      expect(result.candidates).toEqual([]);
    });

    it('should throw ConnectorError with auth_failed on body.status === REQUEST_DENIED', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'REQUEST_DENIED',
            error_message: 'API key invalid',
            results: [],
          }),
          { status: 200 },
        ),
      );

      await expect(
        connector.geocode({ address: 'x' }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'auth_failed',
        providerMessage: 'API key invalid',
      });
    });

    it('should throw ConnectorError with rate_limited on body.status === OVER_QUERY_LIMIT', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'OVER_QUERY_LIMIT', results: [] }),
          { status: 200 },
        ),
      );

      await expect(
        connector.geocode({ address: 'x' }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'rate_limited',
      });
    });

    it('should throw ConnectorError with invalid_request on body.status === INVALID_REQUEST', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'INVALID_REQUEST', results: [] }),
          { status: 200 },
        ),
      );

      await expect(
        connector.geocode({ address: 'x' }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
    });

    it('should merge passthrough query and headers', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      await connector.geocode({
        address: 'x',
        _passthrough: {
          headers: { 'X-Custom': 'value' },
          query: { region: 'us' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('region')).toBe('us');
      expect((init?.headers as Record<string, string>)?.['X-Custom']).toBe(
        'value',
      );
    });
  });

  describe('reverseGeocode', () => {
    it('should GET geocode endpoint with latlng param', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

      const result = await connector.reverseGeocode({
        location: { lat: 37.4224, lng: -122.0842 },
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('latlng')).toBe('37.4224,-122.0842');
      expect(params.get('key')).toBe('test-api-key');

      // reverse-geocode mirrors forward shape — `candidates[]`.
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.formattedAddress).toBe(
        '1600 Amphitheatre Parkway, Mountain View, CA',
      );
      expect(result.candidates[0]!.placeId).toBe('ChIJ2eUgeAK6j4ARbn5u_wAGqWA');
    });

    it('should populate viewport on reverse-geocode candidates', async () => {
      mockFetch.mockResolvedValueOnce(buildGeocodeResponse({ withViewport: true }));

      const result = await connector.reverseGeocode({
        location: { lat: 37.4224, lng: -122.0842 },
      });

      expect(result.candidates[0]!.viewport).toEqual({
        southwest: { lat: 37.42, lng: -122.09 },
        northeast: { lat: 37.43, lng: -122.08 },
      });
    });
  });

  describe('autocomplete (Places NEW API)', () => {
    it('should POST to places.googleapis.com NEW endpoint with X-Goog-Api-Key header', async () => {
      mockFetch.mockResolvedValueOnce(buildPlacesNewAutocompleteResponse());

      const result = await connector.autocomplete({ input: 'New York' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual(
        expect.objectContaining({
          'X-Goog-Api-Key': 'test-api-key',
          'Content-Type': 'application/json',
        }),
      );
      // Auth is via header, NOT a query `key=` param.
      expect((init?.headers as Record<string, string>)?.['X-Goog-Api-Key']).toBe(
        'test-api-key',
      );
      expect(url).not.toContain('key=');

      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body.input).toBe('New York');

      expect(result.predictions).toHaveLength(2);
      expect(result.predictions[0]).toEqual({
        description: 'New York, NY, USA',
        placeId: 'ChIJOwg_06VPwokRYv534QaPC8g',
      });
    });

    it('should include locationBias.circle when location + radius provided', async () => {
      mockFetch.mockResolvedValueOnce(buildPlacesNewAutocompleteResponse());

      await connector.autocomplete({
        input: 'cafe',
        location: { lat: 40.7128, lng: -74.006 },
        radius: 5000,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body.locationBias).toEqual({
        circle: {
          center: { latitude: 40.7128, longitude: -74.006 },
          radius: 5000,
        },
      });
    });

    it('should include languageCode when language provided', async () => {
      mockFetch.mockResolvedValueOnce(buildPlacesNewAutocompleteResponse());

      await connector.autocomplete({ input: 'cafe', language: 'fr' });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body.languageCode).toBe('fr');
    });

    it('should normalize predictions from suggestions[].placePrediction', async () => {
      mockFetch.mockResolvedValueOnce(buildPlacesNewAutocompleteResponse());

      const result = await connector.autocomplete({ input: 'New' });

      expect(result.predictions[1]).toEqual({
        description: 'New York Mills, MN, USA',
        placeId: 'abc123',
      });
    });

    it('should return empty predictions when suggestions is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await connector.autocomplete({ input: 'x' });
      expect(result.predictions).toEqual([]);
    });

    it('should throw ConnectorError on non-2xx autocomplete response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 500 }),
      );

      await expect(
        connector.autocomplete({ input: 'x' }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'provider_unavailable',
        statusCode: 500,
      });
    });
  });

  describe('mapVendorError mapping table (HTTP status)', () => {
    it.each<[number, string]>([
      [401, 'auth_failed'],
      [403, 'auth_failed'],
      [429, 'rate_limited'],
      [400, 'invalid_request'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
      [418, 'unknown'],
    ])('HTTP %i maps to providerCode %s', async (status, expectedCode) => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status }),
      );

      await expect(
        connector.geocode({ address: 'x' }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: expectedCode,
        statusCode: status,
      });
    });
  });

  it('should surface Retry-After header in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_message: 'Quota exceeded' }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );

    let caught: ConnectorError | null = null;
    try {
      await connector.geocode({ address: 'x' });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('rate_limited');
    expect(caught?.statusCode).toBe(429);
    expect(caught?.providerMessage).toBe('Quota exceeded; retry after 30 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('30');
    // No structured retryAfterSeconds field by design.
    expect(
      (caught as unknown as Record<string, unknown>)?.retryAfterSeconds,
    ).toBeUndefined();
  });
});
