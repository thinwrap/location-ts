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

  describe('contour translation', () => {
    function featureResp(contours: number[]): Response {
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: contours.map((contour) => ({
            properties: { contour },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] },
          })),
        }),
        { status: 200 },
      );
    }

    // "Times must be in increasing order" / "Distances must be in increasing
    // order" — so the caller's order cannot be sent as-is.
    it('sends the contours in increasing order', async () => {
      mockFetch.mockResolvedValueOnce(featureResp([10, 30]));
      await connector.isochrone({ center: { lat: 1, lng: 2 }, type: 'time', values: [1800, 600] });
      expect(parseUrlParams(mockFetch.mock.calls[0]![0] as string).get('contours_minutes')).toBe('10,30');

      mockFetch.mockResolvedValueOnce(featureResp([500, 2000]));
      await connector.isochrone({ center: { lat: 1, lng: 2 }, type: 'distance', values: [2000, 500] });
      expect(parseUrlParams(mockFetch.mock.calls[1]![0] as string).get('contours_meters')).toBe('500,2000');
    });

    // 90 s is sent as the nearest whole minute (2) and must come back as 90 s,
    // not 2 × 60.
    it('reports each contour with the caller value, not minutes × 60', async () => {
      mockFetch.mockResolvedValueOnce(featureResp([2, 5]));
      const result = await connector.isochrone({
        center: { lat: 1, lng: 2 },
        type: 'time',
        values: [290, 90],
      });
      expect(parseUrlParams(mockFetch.mock.calls[0]![0] as string).get('contours_minutes')).toBe('2,5');
      expect(result.contours.map((c) => c.value)).toEqual([90, 290]);
    });

    it('rounds distances to whole meters and maps them back', async () => {
      mockFetch.mockResolvedValueOnce(featureResp([1001]));
      const result = await connector.isochrone({
        center: { lat: 1, lng: 2 },
        type: 'distance',
        values: [1000.6],
      });
      expect(parseUrlParams(mockFetch.mock.calls[0]![0] as string).get('contours_meters')).toBe('1001');
      expect(result.contours[0]!.value).toBe(1000.6);
    });

    it.each([
      ['a time under 60 s (rounds to the invalid 0 minutes)', 'time' as const, [29]],
      ['a time just under 60 s', 'time' as const, [45, 600]],
      ['two times that round to the same minute', 'time' as const, [600, 620]],
      ['two distances that round to the same meter', 'distance' as const, [100.2, 100.4]],
      ['a distance that rounds to 0 m', 'distance' as const, [0.3]],
    ])('rejects %s before any request', async (_label, type, values) => {
      await expect(
        connector.isochrone({ center: { lat: 1, lng: 2 }, type, values }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('malformed or empty 2xx bodies', () => {
    it.each([
      ['no features', { type: 'FeatureCollection', features: [] }],
      ['a null feature', { features: [null] }],
      ['a feature without geometry', { features: [{ properties: { contour: 10 } }] }],
      [
        'an empty outer ring',
        { features: [{ properties: { contour: 10 }, geometry: { coordinates: [[]] } }] },
      ],
      [
        'a missing contour value',
        { features: [{ properties: {}, geometry: { coordinates: [[[0, 0], [1, 1]]] } }] },
      ],
    ])('raises unknown for %s', async (_label, body) => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(
        connector.isochrone({ center: { lat: 1, lng: 2 }, type: 'time', values: [600] }),
      ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
    });

    it('maps a 200 NoRoute envelope to no_route', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'NoRoute', message: 'No route found' }), { status: 200 }),
      );
      await expect(
        connector.isochrone({ center: { lat: 1, lng: 2 }, type: 'time', values: [600] }),
      ).rejects.toMatchObject({ providerCode: 'no_route', statusCode: 200 });
    });
  });

  describe('input checks', () => {
    // A `type` outside the vocabulary is misuse of the API, not request data.
    it.each([
      ['an unknown type', { type: 'minutes' }],
      ['an empty type', { type: '' }],
    ])('rejects %s with a TypeError before any request', async (_label, extra) => {
      const error = await connector
        .isochrone({
          center: { lat: 1, lng: 2 },
          values: [600],
          ...(extra as { type: 'time' }),
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ConnectorError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ['an unparseable departureTime', { type: 'time', departureTime: 'tomorrow-ish' }],
    ])('rejects %s before any request', async (_label, extra) => {
      await expect(
        connector.isochrone({
          center: { lat: 1, lng: 2 },
          values: [600],
          ...(extra as { type: 'time' }),
        }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

describe('MapboxIsochroneConnector — MultiPolygon features, holes and winding', () => {
  // Closed [lng, lat] squares wound counter-clockwise (RFC 7946 exterior).
  const A_CCW = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const HOLE_A_CCW = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
  const B_CCW = [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]];
  const cw = (ring: number[][]) => [...ring].reverse();

  const signedArea = (ring: number[][]) =>
    ring.slice(0, -1).reduce((sum, [x1, y1], i) => {
      const [x2, y2] = ring[i + 1]!;
      return sum + x1! * y2! - x2! * y1!;
    }, 0);

  async function geometryFor(geometry: unknown) {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { contour: 10 }, geometry }] }),
        { status: 200 },
      ),
    );
    const result = await new MapboxIsochroneConnector(defaultConfig).isochrone({
      center: { lat: 5, lng: 5 },
      type: 'time',
      values: [600],
    });
    return result.contours[0]!.geometry;
  }

  it('maps a two-part MultiPolygon feature to a MultiPolygon with both parts', async () => {
    const geometry = await geometryFor({
      type: 'MultiPolygon',
      coordinates: [[cw(A_CCW), HOLE_A_CCW], [B_CCW]],
    });
    expect(geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[A_CCW, cw(HOLE_A_CCW)], [B_CCW]],
    });
  });

  it('reports a one-part MultiPolygon as a Polygon', async () => {
    const geometry = await geometryFor({ type: 'MultiPolygon', coordinates: [[A_CCW]] });
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW] });
  });

  it('keeps a Polygon hole and normalizes winding (exterior CCW, hole CW)', async () => {
    const geometry = await geometryFor({ type: 'Polygon', coordinates: [cw(A_CCW), HOLE_A_CCW] });
    expect(geometry.type).toBe('Polygon');
    const [exterior, hole] = geometry.coordinates as number[][][];
    expect(signedArea(exterior!)).toBeGreaterThan(0);
    expect(signedArea(hole!)).toBeLessThan(0);
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW, cw(HOLE_A_CCW)] });
  });

  it('reads a geometry without a type as a Polygon', async () => {
    const geometry = await geometryFor({ coordinates: [A_CCW] });
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW] });
  });

  it('drops an unusable MultiPolygon part and keeps the rest', async () => {
    const geometry = await geometryFor({ type: 'MultiPolygon', coordinates: [[[]], [B_CCW]] });
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [B_CCW] });
  });

  it.each([
    ['a LineString', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
    ['a MultiPolygon with no usable part', { type: 'MultiPolygon', coordinates: [[[]], [[[0]]]] }],
    ['an empty MultiPolygon', { type: 'MultiPolygon', coordinates: [] }],
  ])('raises unknown for %s', async (_label, geometry) => {
    await expect(geometryFor(geometry)).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
  });
});
