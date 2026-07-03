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

  it('maps travel modes correctly (driving/walking/cycling)', async () => {
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
      travelMode: 'cycling',
    } as unknown as Parameters<typeof connector.isochrone>[0]);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('travelMode=bicycle');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(buildReachableRangeResponse());
    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
      travelMode: 'walking',
    });
    expect(mockFetch.mock.calls[0]![0] as string).toContain('travelMode=pedestrian');
  });

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
