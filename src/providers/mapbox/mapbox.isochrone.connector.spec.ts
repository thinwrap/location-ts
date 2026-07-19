import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapboxIsochroneConnector } from './mapbox.isochrone.connector';
import type { MapboxConfig } from './mapbox.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: MapboxConfig = { accessToken: 'pk.test123' };

function buildIsochroneResponse() {
  return new Response(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          properties: { contour: 20, metric: 'time' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-74.02, 40.70], [-73.98, 40.73], [-74.02, 40.70]]],
          },
        },
        {
          properties: { contour: 10, metric: 'time' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-74.006, 40.7128], [-73.99, 40.72], [-74.006, 40.7128]]],
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

describe('MapboxIsochroneConnector', () => {
  let connector: MapboxIsochroneConnector;

  beforeEach(() => {
    connector = new MapboxIsochroneConnector(defaultConfig);
  });

  it('should have providerId "mapbox"', () => {
    expect(connector.providerId).toBe('mapbox');
  });

  it('should GET isochrone v1 with contours_minutes for time type and polygons=true invariant', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600, 1200],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/isochrone/v1/mapbox/driving/-74.006,40.7128');
    const params = parseUrlParams(url as string);
    expect(params.get('contours_minutes')).toBe('10,20');
    expect(params.get('polygons')).toBe('true');
    expect(params.get('access_token')).toBe('pk.test123');

    expect(result.contours).toHaveLength(2);
    // Sorted ascending; contour=10min → 600s
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[1]!.value).toBe(1200);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
  });

  it('should use contours_meters for distance type (native, no conversion)', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'distance',
      values: [1000, 2000],
    });

    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.get('contours_meters')).toBe('1000,2000');
    expect(params.get('contours_minutes')).toBeNull();
  });

  it('should map walking → mapbox/walking profile', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'walking',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/mapbox/walking/');
  });

  it('should map cycling → mapbox/cycling profile', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    // Cast through IIsochroneOptions to bypass base narrowed type; the
    // facade-level `IsochroneOptionsMap['mapbox']` augmentation widens this.
    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'cycling',
    } as unknown as Parameters<typeof connector.isochrone>[0]);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/mapbox/cycling/');
  });

  it('should enforce the 4-value cap', async () => {
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [60, 120, 180, 240, 300],
      }),
    ).rejects.toMatchObject({
      providerCode: 'invalid_request',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should overwrite a consumer attempt to disable polygons=true', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      _passthrough: { query: { polygons: 'false' } },
    });

    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.get('polygons')).toBe('true');
  });

  it('should forward departureTime via depart_at query parameter', async () => {
    mockFetch.mockResolvedValueOnce(buildIsochroneResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      departureTime: '2026-05-17T12:00:00Z',
    });

    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.get('depart_at')).toBe('2026-05-17T12:00:00Z');
  });

  it('should throw ConnectorError with auth_failed on 401', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not authorized' }), { status: 401 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({
      providerCode: 'auth_failed',
      statusCode: 401,
    });
  });

  it('should throw ConnectorError with rate_limited on 429 and surface Retry-After', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Slow down' }), {
        status: 429,
        headers: { 'retry-after': '42' },
      }),
    );

    let caught: unknown;
    try {
      await connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    const e = caught as ConnectorError;
    expect(e.providerCode).toBe('rate_limited');
    expect(e.providerMessage).toContain('retry after 42 seconds');
    expect((e.cause as { retryAfter?: string } | null)?.retryAfter).toBe('42');
  });

  it('should throw ConnectorError on 422 invalid request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Invalid contour' }), { status: 422 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({
      providerCode: 'invalid_request',
    });
  });

  it('rejects a non-finite center with ConnectorError invalid_request (no fetch)', async () => {
    await expect(
      connector.isochrone({
        center: { lat: Number.NaN, lng: -74.006 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'invalid_request',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
