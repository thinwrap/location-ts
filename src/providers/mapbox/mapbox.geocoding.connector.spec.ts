import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapboxGeocodingConnector } from './mapbox.geocoding.connector';
import type { MapboxConfig } from './mapbox.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const defaultConfig: MapboxConfig = { accessToken: 'pk.test123' };

function buildV6Response(
  features: Array<Record<string, unknown>> = [
    {
      geometry: {
        type: 'Point',
        coordinates: [-122.0842, 37.4224],
      },
      properties: {
        mapbox_id: 'dXJuOm1ieHBsYzphZGRyZXNz',
        full_address: '1600 Amphitheatre Parkway, Mountain View, CA 94043',
        bbox: [-122.085, 37.421, -122.083, 37.424],
      },
    },
  ],
  init?: ResponseInit,
): Response {
  return new Response(
    JSON.stringify({ type: 'FeatureCollection', features }),
    { status: 200, ...init },
  );
}

function buildSearchboxResponse(
  suggestions: Array<Record<string, unknown>> = [
    {
      name: 'Blue Bottle Coffee',
      full_address: 'Blue Bottle Coffee, 66 Mint St, San Francisco, CA',
      mapbox_id: 'dXJuOm1ieHBvaTpzdWdn',
    },
  ],
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify({ suggestions }), { status: 200, ...init });
}

function parseUrlParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.substring(q + 1) : '');
}

describe('MapboxGeocodingConnector', () => {
  let connector: MapboxGeocodingConnector;

  beforeEach(() => {
    connector = new MapboxGeocodingConnector(defaultConfig);
  });

  it('should have providerId "mapbox"', () => {
    expect(connector.providerId).toBe('mapbox');
  });

  // ===== Forward geocoding — =====
  describe('geocode (Geocoding v6 forward)', () => {
    it('should GET v6 forward with q + access_token', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      const result = await connector.geocode({ address: '1600 Amphitheatre' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(init?.method).toBe('GET');
      expect(url).toContain('https://api.mapbox.com/search/geocode/v6/forward');
      const params = parseUrlParams(url as string);
      expect(params.get('q')).toBe('1600 Amphitheatre');
      expect(params.get('access_token')).toBe('pk.test123');

      expect(result.candidates).toHaveLength(1);
    });

    // `countryFilter` → `country=` lowercase, comma-separated
    it('should translate countryFilter to lowercase country= comma list', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      await connector.geocode({
        address: 'Main St',
        countryFilter: ['US', 'CA'],
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('country')).toBe('us,ca');
    });

    it('should omit country= when countryFilter is empty or absent', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      await connector.geocode({ address: 'Main St' });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('country')).toBeNull();
    });

    it('should pass language= when provided', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      await connector.geocode({ address: 'Main St', language: 'fr' });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('language')).toBe('fr');
    });

    // Response normalization
    it('should normalize v6 features to candidates using properties.full_address, geometry.coordinates, properties.mapbox_id, and properties.bbox', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      const result = await connector.geocode({ address: '1600 Amphitheatre' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.formattedAddress).toBe(
        '1600 Amphitheatre Parkway, Mountain View, CA 94043',
      );
      // GeoJSON [lng, lat] order → swapped into { lat, lng }
      expect(c.location).toEqual({ lat: 37.4224, lng: -122.0842 });
      expect(c.placeId).toBe('dXJuOm1ieHBsYzphZGRyZXNz');
      // viewport from properties.bbox = [west, south, east, north]
      expect(c.viewport).toEqual({
        southwest: { lat: 37.421, lng: -122.085 },
        northeast: { lat: 37.424, lng: -122.083 },
      });
    });

    // fallback to `place_name` when `properties.full_address` is absent
    it('should fall back to place_name when properties.full_address is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildV6Response([
          {
            geometry: { type: 'Point', coordinates: [-73.9857, 40.7484] },
            properties: { mapbox_id: 'id1' },
            place_name: 'Empire State Building, New York, NY',
          },
        ]),
      );

      const result = await connector.geocode({ address: 'Empire' });
      expect(result.candidates[0]!.formattedAddress).toBe(
        'Empire State Building, New York, NY',
      );
    });

    it('should omit viewport when properties.bbox is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildV6Response([
          {
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { full_address: 'Null Island', mapbox_id: 'id0' },
          },
        ]),
      );

      const result = await connector.geocode({ address: 'Null Island' });
      expect(result.candidates[0]!.viewport).toBeUndefined();
    });

    it('should expose the full vendor body on result.raw', async () => {
      const body = {
        type: 'FeatureCollection',
        features: [
          {
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: { mapbox_id: 'x', full_address: 'X' },
          },
        ],
      };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      const result = await connector.geocode({ address: 'X' });
      expect(result.raw).toEqual(body);
    });
  });

  // ===== Reverse geocoding — =====
  describe('reverseGeocode (Geocoding v6 reverse)', () => {
    it('should GET v6 reverse with longitude + latitude query params', async () => {
      mockFetch.mockResolvedValueOnce(buildV6Response());

      await connector.reverseGeocode({
        location: { lat: 37.4224, lng: -122.0842 },
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('https://api.mapbox.com/search/geocode/v6/reverse');
      const params = parseUrlParams(url as string);
      expect(params.get('longitude')).toBe('-122.0842');
      expect(params.get('latitude')).toBe('37.4224');
      expect(params.get('access_token')).toBe('pk.test123');
    });

    // reverse-geocode mirrors forward `candidates[]` shape
    it('should return all ranked candidates, not just the first feature', async () => {
      mockFetch.mockResolvedValueOnce(
        buildV6Response([
          {
            geometry: { type: 'Point', coordinates: [-122.084, 37.422] },
            properties: { mapbox_id: 'a', full_address: 'A' },
          },
          {
            geometry: { type: 'Point', coordinates: [-122.085, 37.423] },
            properties: { mapbox_id: 'b', full_address: 'B' },
          },
          {
            geometry: { type: 'Point', coordinates: [-122.086, 37.424] },
            properties: { mapbox_id: 'c', full_address: 'C' },
          },
        ]),
      );

      const result = await connector.reverseGeocode({
        location: { lat: 37.4224, lng: -122.0842 },
      });

      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((c) => c.placeId)).toEqual(['a', 'b', 'c']);
    });
  });

  // ===== Autocomplete — =====
  describe('autocomplete (Searchbox /suggest)', () => {
    it('should GET Searchbox /suggest with q + access_token', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchboxResponse());

      await connector.autocomplete({ input: 'coffee' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain(
        'https://api.mapbox.com/search/searchbox/v1/suggest',
      );
      const params = parseUrlParams(url as string);
      expect(params.get('q')).toBe('coffee');
      expect(params.get('access_token')).toBe('pk.test123');
    });

    // UUID session_token generated per call via crypto.randomUUID
    it('should generate a session_token via crypto.randomUUID per call', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchboxResponse());
      const uuidSpy = vi
        .spyOn(webcrypto, 'randomUUID')
        .mockReturnValue('00000000-0000-4000-8000-000000000000');

      await connector.autocomplete({ input: 'coffee' });

      expect(uuidSpy).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('session_token')).toBe(
        '00000000-0000-4000-8000-000000000000',
      );
    });

    it('should generate a fresh session_token on each autocomplete call', async () => {
      mockFetch.mockImplementation(async () => buildSearchboxResponse());
      const uuidSpy = vi
        .spyOn(webcrypto, 'randomUUID')
        .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

      await connector.autocomplete({ input: 'one' });
      await connector.autocomplete({ input: 'two' });

      expect(uuidSpy).toHaveBeenCalledTimes(2);
      const params1 = parseUrlParams(mockFetch.mock.calls[0]![0] as string);
      const params2 = parseUrlParams(mockFetch.mock.calls[1]![0] as string);
      expect(params1.get('session_token')).toBe(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      expect(params2.get('session_token')).toBe(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      );
    });

    // consumer-supplied session_token via _passthrough.query overrides
    // the generated UUID (mergePassthrough last-write-wins on query).
    it('should let consumer override session_token via _passthrough.query.session_token', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchboxResponse());
      vi.spyOn(webcrypto, 'randomUUID').mockReturnValue(
        '00000000-0000-4000-8000-000000000000',
      );

      await connector.autocomplete({
        input: 'coffee',
        _passthrough: { query: { session_token: 'persistent-session-123' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('session_token')).toBe('persistent-session-123');
    });

    // `radius` is documented no-op (Searchbox lacks first-class radius)
    it('should not forward radius to Searchbox (documented no-op)', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchboxResponse());

      await connector.autocomplete({ input: 'coffee', radius: 1000 });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('radius')).toBeNull();
    });

    it('should pass _passthrough.query.proximity for proximity biasing', async () => {
      mockFetch.mockResolvedValueOnce(buildSearchboxResponse());

      await connector.autocomplete({
        input: 'coffee',
        _passthrough: { query: { proximity: '-74.006,40.7128' } },
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('proximity')).toBe('-74.006,40.7128');
    });

    // Searchbox response normalization
    it('should map Searchbox suggestions to predictions (full_address → description, mapbox_id → placeId)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchboxResponse([
          {
            name: 'Blue Bottle',
            full_address: 'Blue Bottle Coffee, 66 Mint St, San Francisco, CA',
            mapbox_id: 'id1',
          },
          {
            name: 'Sightglass',
            full_address: 'Sightglass Coffee, 270 7th St, San Francisco, CA',
            mapbox_id: 'id2',
          },
        ]),
      );

      const result = await connector.autocomplete({ input: 'coffee' });

      expect(result.predictions).toHaveLength(2);
      expect(result.predictions[0]).toEqual({
        description: 'Blue Bottle Coffee, 66 Mint St, San Francisco, CA',
        placeId: 'id1',
      });
      expect(result.predictions[1]!.description).toBe(
        'Sightglass Coffee, 270 7th St, San Francisco, CA',
      );
    });

    it('should fall back to suggestion.name when full_address is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSearchboxResponse([{ name: 'Bare Name', mapbox_id: 'id1' }]),
      );

      const result = await connector.autocomplete({ input: 'bare' });
      expect(result.predictions[0]!.description).toBe('Bare Name');
    });
  });

  // ===== mapVendorError =====
  describe('mapVendorError mapping table', () => {
    it.each<[number, Record<string, unknown> | null, string]>([
      [401, null, 'auth_failed'],
      [403, null, 'auth_failed'],
      [422, { message: 'unprocessable' }, 'invalid_request'],
      [429, null, 'rate_limited'],
      [500, null, 'provider_unavailable'],
      [503, null, 'provider_unavailable'],
      [418, null, 'unknown'],
    ])(
      'HTTP %i maps to providerCode %s',
      async (status, errorBody, expectedCode) => {
        mockFetch.mockResolvedValueOnce(
          new Response(errorBody === null ? '' : JSON.stringify(errorBody), {
            status,
          }),
        );

        await expect(
          connector.geocode({ address: 'test' }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: expectedCode,
          statusCode: status,
        });
      },
    );

    it('should throw ConnectorError on Searchbox API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Invalid token' }), {
          status: 401,
        }),
      );

      await expect(
        connector.autocomplete({ input: 'test' }),
      ).rejects.toBeInstanceOf(ConnectorError);
    });

    it('should throw ConnectorError on reverse-geocode API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'bad coordinates' }), {
          status: 422,
        }),
      );

      await expect(
        connector.reverseGeocode({ location: { lat: 0, lng: 0 } }),
      ).rejects.toBeInstanceOf(ConnectorError);
    });
  });

  // Retry-After surface: parsed seconds in providerMessage + raw on cause
  // (no structured retryAfterSeconds field by design)
  it('should surface Retry-After in providerMessage and cause.retryAfter', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );

    let caught: ConnectorError | null = null;
    try {
      await connector.geocode({ address: 'test' });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('rate_limited');
    expect(caught?.statusCode).toBe(429);
    expect(caught?.providerMessage).toBe(
      'Rate limit exceeded; retry after 30 seconds',
    );
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('30');
    expect(
      (caught as unknown as Record<string, unknown>)?.retryAfterSeconds,
    ).toBeUndefined();
  });
});
