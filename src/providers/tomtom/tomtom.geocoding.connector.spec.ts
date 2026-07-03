import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TomTomGeocodingConnector } from './tomtom.geocoding.connector';
import type { TomTomConfig } from './tomtom.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: TomTomConfig = { apiKey: 'test-key' };

function buildGeocodeResponse() {
  return new Response(
    JSON.stringify({
      summary: { numResults: 1, totalResults: 1 },
      results: [
        {
          type: 'Street',
          id: 'tom-id-1',
          score: 10,
          address: { freeformAddress: '1600 Amphitheatre Parkway, Mountain View, CA' },
          position: { lat: 37.42, lon: -122.08 },
          viewport: {
            topLeftPoint: { lat: 37.43, lon: -122.09 },
            btmRightPoint: { lat: 37.41, lon: -122.07 },
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function buildReverseGeocodeResponse() {
  return new Response(
    JSON.stringify({
      summary: { numResults: 1 },
      addresses: [
        {
          address: { freeformAddress: '1600 Amphitheatre Parkway, Mountain View, CA' },
          position: '37.42,-122.08',
          id: 'rev-id-1',
        },
      ],
    }),
    { status: 200 },
  );
}

function buildSearchResponse() {
  return new Response(
    JSON.stringify({
      summary: { numResults: 2, totalResults: 2 },
      results: [
        {
          type: 'POI',
          id: 'poi-1',
          address: { freeformAddress: 'New York, NY' },
          position: { lat: 40.71, lon: -74.01 },
          poi: { name: 'Empire State Building' },
        },
        {
          type: 'Geography',
          id: 'geo-1',
          address: { freeformAddress: 'New York, NY, USA' },
          position: { lat: 40.71, lon: -74.01 },
        },
      ],
    }),
    { status: 200 },
  );
}

describe('TomTomGeocodingConnector', () => {
  let connector: TomTomGeocodingConnector;

  beforeEach(() => {
    connector = new TomTomGeocodingConnector(defaultConfig);
  });

  it('should have providerId "tomtom"', () => {
    expect(connector.providerId).toBe('tomtom');
  });

  it('should forward geocode with address in URL path (path-form, not q=)', async () => {
    mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

    const result = await connector.geocode({ address: '1600 Amphitheatre Parkway' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    const u = url as string;

    expect(u).toContain('api.tomtom.com/search/2/geocode');
    expect(u).toContain('1600%20Amphitheatre%20Parkway');
    expect(u).toContain('key=test-key');
    expect(u).not.toContain('q=');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.location).toEqual({ lat: 37.42, lng: -122.08 });
    expect(result.candidates[0]!.formattedAddress).toBe(
      '1600 Amphitheatre Parkway, Mountain View, CA',
    );
    expect(result.candidates[0]!.placeId).toBe('tom-id-1');
  });

  it('should convert TomTom viewport (topLeftPoint/btmRightPoint) → southwest/northeast', async () => {
    mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

    const result = await connector.geocode({ address: '1600 Amphitheatre Parkway' });

    const vp = result.candidates[0]!.viewport;
    expect(vp).toEqual({
      southwest: { lat: 37.41, lng: -122.09 }, // br.lat, tl.lon
      northeast: { lat: 37.43, lng: -122.07 }, // tl.lat, br.lon
    });
  });

  it('should leave viewport undefined when TomTom omits it', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          summary: { numResults: 1, totalResults: 1 },
          results: [
            {
              type: 'Street',
              id: 'x',
              score: 1,
              address: { freeformAddress: 'A' },
              position: { lat: 0, lon: 0 },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await connector.geocode({ address: 'x' });
    expect(result.candidates[0]!.viewport).toBeUndefined();
  });

  it('should reverse geocode with coordinates in URL path', async () => {
    mockFetch.mockResolvedValueOnce(buildReverseGeocodeResponse());

    const result = await connector.reverseGeocode({
      location: { lat: 37.42, lng: -122.08 },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    const u = url as string;

    expect(u).toContain('api.tomtom.com/search/2/reverseGeocode');
    expect(u).toContain('37.42,-122.08');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.formattedAddress).toBe(
      '1600 Amphitheatre Parkway, Mountain View, CA',
    );
    expect(result.candidates[0]!.location).toEqual({ lat: 37.42, lng: -122.08 });
  });

  it('should autocomplete via /search with typeahead=true', async () => {
    mockFetch.mockResolvedValueOnce(buildSearchResponse());

    const result = await connector.autocomplete({ input: 'Empire State' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    const u = url as string;

    expect(u).toContain('api.tomtom.com/search/2/search');
    expect(u).toContain('Empire%20State');
    expect(u).toContain('typeahead=true');

    expect(result.predictions).toHaveLength(2);
    expect(result.predictions[0]!.description).toBe(
      'Empire State Building, New York, NY',
    );
    expect(result.predictions[1]!.description).toBe('New York, NY, USA');
  });

  it('should pass language and countryFilter for geocode', async () => {
    mockFetch.mockResolvedValueOnce(buildGeocodeResponse());

    await connector.geocode({
      address: 'Berlin',
      language: 'de',
      countryFilter: ['DE', 'AT'],
    });

    const [url] = mockFetch.mock.calls[0]!;
    const u = url as string;
    expect(u).toContain('language=de');
    expect(u).toContain('countrySet=DE%2CAT');
  });

  it('should pass location and radius for autocomplete', async () => {
    mockFetch.mockResolvedValueOnce(buildSearchResponse());

    await connector.autocomplete({
      input: 'test',
      location: { lat: 40.71, lng: -74.01 },
      radius: 5000,
    });

    const [url] = mockFetch.mock.calls[0]!;
    const u = url as string;
    expect(u).toContain('lat=40.71');
    expect(u).toContain('lon=-74.01');
    expect(u).toContain('radius=5000');
  });

  it('should map 401 → auth_failed', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'No key' } }), {
        status: 401,
      }),
    );

    await expect(connector.geocode({ address: 'x' })).rejects.toMatchObject({
      providerCode: 'auth_failed',
      statusCode: 401,
    });
  });

  it('should map 400 → invalid_request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorText: 'Bad request' }), { status: 400 }),
    );

    await expect(connector.geocode({ address: 'x' })).rejects.toMatchObject({
      providerCode: 'invalid_request',
    });
  });

  it('should map 429 → rate_limited and surface Retry-After', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'Slow down' } }), {
        status: 429,
        headers: { 'retry-after': '20' },
      }),
    );

    let caught: unknown;
    try {
      await connector.geocode({ address: 'x' });
    } catch (err) {
      caught = err;
    }
    const e = caught as ConnectorError;
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e.providerCode).toBe('rate_limited');
    expect(e.providerMessage).toContain('retry after 20 seconds');
    expect((e.cause as { retryAfter?: string } | null)?.retryAfter).toBe('20');
  });

  it('should map 5xx → provider_unavailable', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'down' } }), { status: 503 }),
    );

    await expect(connector.geocode({ address: 'x' })).rejects.toMatchObject({
      providerCode: 'provider_unavailable',
    });
  });
});
