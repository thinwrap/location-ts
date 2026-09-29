import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TomTomIsochroneConnector } from './tomtom.isochrone.connector';
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

function buildReachableRangeResponse() {
  return new Response(
    JSON.stringify({
      reachableRange: {
        center: { latitude: 40.7128, longitude: -74.006 },
        boundary: [
          { latitude: 40.72, longitude: -74.01 },
          { latitude: 40.73, longitude: -74.00 },
          { latitude: 40.72, longitude: -73.99 },
          { latitude: 40.71, longitude: -74.00 },
        ],
      },
    }),
    { status: 200 },
  );
}

describe('TomTomIsochroneConnector', () => {
  let connector: TomTomIsochroneConnector;

  beforeEach(() => {
    connector = new TomTomIsochroneConnector(defaultConfig);
  });

  it('should have providerId "tomtom"', () => {
    expect(connector.providerId).toBe('tomtom');
  });

  it('single-band path: one HTTP call and _meta omitted (N=1)', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain(
      'api.tomtom.com/routing/1/calculateReachableRange/40.7128,-74.006/json',
    );
    expect(url as string).toContain('timeBudgetInSec=600');
    expect(url as string).toContain('key=test-key');
    expect(url as string).toContain('travelMode=car');

    // `_meta` is present iff N>1; a single-band request is one HTTP call, so
    // the key is omitted entirely.
    expect(result._meta).toBeUndefined();
    expect('_meta' in result).toBe(false);
    expect(result.contours).toHaveLength(1);
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
  });

  it('multi-band path: N parallel calls and _meta.requestCount=N', async () => {
    mockFetch
      .mockResolvedValueOnce(buildReachableRangeResponse())
      .mockResolvedValueOnce(buildReachableRangeResponse())
      .mockResolvedValueOnce(buildReachableRangeResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600, 1200, 1800],
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify each request had a distinct budget value.
    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('timeBudgetInSec=600'))).toBe(true);
    expect(urls.some((u) => u.includes('timeBudgetInSec=1200'))).toBe(true);
    expect(urls.some((u) => u.includes('timeBudgetInSec=1800'))).toBe(true);

    expect(result._meta).toEqual({ requestCount: 3 });
    expect(result.contours).toHaveLength(3);
    // Sorted ascending.
    expect(result.contours.map((c) => c.value)).toEqual([600, 1200, 1800]);
  });

  it('uses distanceBudgetInMeters for distance type', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());

    await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'distance',
      values: [5000],
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('distanceBudgetInMeters=5000');
    expect(url as string).not.toContain('timeBudgetInSec=');
  });

  it('closes the polygon ring on output', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600],
    });

    const coords = (result.contours[0]!.geometry as { coordinates: number[][][] })
      .coordinates[0]!;
    expect(coords[0]).toEqual(coords[coords.length - 1]);
    // 4 boundary points + 1 closing = 5
    expect(coords).toHaveLength(5);
  });

  it('maps driving (and unset) to travelMode=car', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());
    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
      travelMode: 'driving',
    });
    expect(mockFetch.mock.calls[0]![0] as string).toContain('travelMode=car');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());
    await connector.isochrone({ center: { lat: 0, lng: 0 }, type: 'time', values: [300] });
    expect(mockFetch.mock.calls[0]![0] as string).toContain('travelMode=car');
  });

  // TomTom: "In calculateReachableRange requests, the values bicycle and
  // pedestrian must not be used."
  for (const mode of ['walking', 'cycling'] as const) {
    it(`rejects ${mode} with unsupported_travel_mode before any request`, async () => {
      const err = await connector
        .isochrone({
          center: { lat: 0, lng: 0 },
          type: 'time',
          values: [300, 600],
          travelMode: mode,
        } as Parameters<typeof connector.isochrone>[0])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).providerCode).toBe('unsupported_travel_mode');
      expect((err as ConnectorError).statusCode).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  }

  it('forwards departureTime via departAt query parameter', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
      departureTime: '2026-05-17T12:00:00Z',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('departAt=2026-05-17T12%3A00%3A00Z');
  });

  it('enforces the 4-value cap', async () => {
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [60, 120, 180, 240, 300],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Promise.all semantics: if ANY band fails the whole call rejects', async () => {
    mockFetch
      .mockResolvedValueOnce(buildReachableRangeResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { description: 'Bad' } }), { status: 400 }),
      )
      .mockResolvedValueOnce(buildReachableRangeResponse());

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600, 1200, 1800],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
  });

  it('maps 400 → invalid_request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'Bad request' } }), {
        status: 400,
      }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
  });

  it('maps 401 → auth_failed', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'no key' } }), {
        status: 401,
      }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'auth_failed' });
  });

  it('maps 429 → rate_limited and surfaces Retry-After', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'Slow down' } }), {
        status: 429,
        headers: { 'retry-after': '15' },
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
    const e = caught as ConnectorError;
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e.providerCode).toBe('rate_limited');
    expect(e.providerMessage).toContain('retry after 15 seconds');
    expect((e.cause as { retryAfter?: string } | null)?.retryAfter).toBe('15');
  });

  it('maps 5xx → provider_unavailable', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { description: 'down' } }), { status: 503 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'provider_unavailable' });
  });
});

describe('TomTomIsochroneConnector — winding and closure', () => {
  const signedArea = (ring: number[][]) =>
    ring.slice(0, -1).reduce((sum, [x1, y1], i) => {
      const [x2, y2] = ring[i + 1]!;
      return sum + x1! * y2! - x2! * y1!;
    }, 0);

  async function geometryFor(boundary: Array<{ latitude: number; longitude: number }>) {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ reachableRange: { boundary } }), { status: 200 }),
    );
    const result = await new TomTomIsochroneConnector(defaultConfig).isochrone({
      center: { lat: 5, lng: 5 },
      type: 'time',
      values: [600],
    });
    return result.contours[0]!.geometry;
  }

  it('winds a clockwise boundary counter-clockwise, as a closed Polygon', async () => {
    // (0,0) → (0,10) → (10,10) → (10,0) in [lng, lat] is clockwise.
    const geometry = await geometryFor([
      { latitude: 0, longitude: 0 },
      { latitude: 10, longitude: 0 },
      { latitude: 10, longitude: 10 },
      { latitude: 0, longitude: 10 },
    ]);
    expect(geometry.type).toBe('Polygon');
    const [ring, ...holes] = geometry.coordinates as number[][][];
    expect(holes).toHaveLength(0);
    expect(signedArea(ring!)).toBeGreaterThan(0);
    expect(ring).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it('does not append a duplicate end point to an already-closed boundary', async () => {
    const geometry = await geometryFor([
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 10 },
      { latitude: 10, longitude: 10 },
      { latitude: 10, longitude: 0 },
      { latitude: 0, longitude: 0 },
    ]);
    expect(geometry.coordinates).toEqual([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
  });
});
