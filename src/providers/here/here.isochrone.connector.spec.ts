import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HereIsochroneConnector } from './here.isochrone.connector';
import type { HereConfig } from './here.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: HereConfig = { apiKey: 'test-here-key' };

// Reference flex-polyline string from HERE docs that decodes to a short
// open ring; the connector closes it.
const FLEX_OUTER = 'BFoz5xJ67i1B1B7PzIhaxL7Y';

function buildIsolineResponse() {
  return new Response(
    JSON.stringify({
      isolines: [
        {
          range: { type: 'time', value: 1200 },
          polygons: [{ outer: FLEX_OUTER }],
        },
        {
          range: { type: 'time', value: 600 },
          polygons: [{ outer: FLEX_OUTER }],
        },
      ],
    }),
    { status: 200 },
  );
}

describe('HereIsochroneConnector', () => {
  let connector: HereIsochroneConnector;

  beforeEach(() => {
    connector = new HereIsochroneConnector(defaultConfig);
  });

  it('should have providerId "here"', () => {
    expect(connector.providerId).toBe('here');
  });

  it('should GET isolines with range params and apiKey', async () => {
    mockFetch.mockResolvedValueOnce(buildIsolineResponse());

    const result = await connector.isochrone({
      center: { lat: 52.52, lng: 13.405 },
      type: 'time',
      values: [600, 1200],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    const u = url as string;
    expect(u).toContain('https://isoline.router.hereapi.com/v8/isolines');
    expect(u).toContain('apiKey=test-here-key');
    expect(u).toContain('range%5Btype%5D=time');
    expect(u).toContain('range%5Bvalues%5D=600%2C1200');
    expect(u).toContain('origin=52.52%2C13.405');
    expect(u).toContain('transportMode=car');
    expect(init?.method).toBe('GET');

    // Contours sorted ascending.
    expect(result.contours).toHaveLength(2);
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[1]!.value).toBe(1200);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
  });

  it('should decode flex-polyline into a closed GeoJSON ring', async () => {
    mockFetch.mockResolvedValueOnce(buildIsolineResponse());

    const result = await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
    });

    const polygon = result.contours[0]!.geometry as {
      type: 'Polygon';
      coordinates: number[][][];
    };
    expect(polygon.type).toBe('Polygon');
    const ring = polygon.coordinates[0]!;
    expect(ring.length).toBeGreaterThan(0);
    // First and last coordinates must match (closed ring).
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('should map walking → transportMode=pedestrian', async () => {
    mockFetch.mockResolvedValueOnce(buildIsolineResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'distance',
      values: [1000],
      travelMode: 'walking',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('transportMode=pedestrian');
  });

  it('should forward departureTime when supplied', async () => {
    mockFetch.mockResolvedValueOnce(buildIsolineResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      departureTime: '2026-05-17T12:00:00Z',
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('departureTime=2026-05-17T12%3A00%3A00Z');
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

  it('should throw ConnectorError with invalid_request on 400', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'Bad request', cause: 'bad range' }), {
        status: 400,
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
    expect((caught as ConnectorError).providerCode).toBe('invalid_request');
    expect((caught as ConnectorError).providerMessage).toContain('Bad request');
  });

  it('should throw ConnectorError with auth_failed on 401', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'Unauthorized' }), { status: 401 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'auth_failed' });
  });

  it('should throw ConnectorError with rate_limited on 429 and surface Retry-After', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'Too many' }), {
        status: 429,
        headers: { 'retry-after': '30' },
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
    expect(e.providerMessage).toContain('retry after 30 seconds');
    expect((e.cause as { retryAfter?: string } | null)?.retryAfter).toBe('30');
  });

  it('should throw ConnectorError with provider_unavailable on 503', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'Service unavailable' }), { status: 503 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'provider_unavailable' });
  });

  // Success-path malformed body: a 200 OK whose JSON fails to parse yields null
  // via `.catch(() => null)` and must surface a typed ConnectorError rather than
  // an uncaught SyntaxError.
  it('should throw ConnectorError on a malformed (non-JSON) 200 body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    let caught: ConnectorError | null = null;
    try {
      await connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('unknown');
    expect(caught?.message).toBe('HERE Isochrone returned a malformed response body');
  });
});

describe('HereIsochroneConnector — multi-part isolines, holes and winding', () => {
  // Minimal 2D flexible-polyline encoder (precision 5) for fixtures, per
  // https://github.com/heremaps/flexible-polyline.
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const unsigned = (value: number): string => {
    let out = '';
    let v = value;
    while (v > 0x1f) {
      out += CHARS[(v & 0x1f) | 0x20];
      v = Math.floor(v / 32);
    }
    return out + CHARS[v];
  };
  const signed = (v: number) => unsigned(v < 0 ? ~(v << 1) : v << 1);
  /** Encodes `[lng, lat]` positions (open ring — HERE does not repeat the first point). */
  const flex = (ring: number[][]): string => {
    let out = unsigned(1) + unsigned(5);
    let prevLat = 0;
    let prevLng = 0;
    for (const [lng, lat] of ring) {
      const la = Math.round(lat! * 1e5);
      const ln = Math.round(lng! * 1e5);
      out += signed(la - prevLat) + signed(ln - prevLng);
      prevLat = la;
      prevLng = ln;
    }
    return out;
  };

  // Closed [lng, lat] squares wound counter-clockwise (RFC 7946 exterior).
  const A_CCW = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const HOLE_A_CCW = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
  const B_CCW = [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]];
  const cw = (ring: number[][]) => [...ring].reverse();
  const open = (ring: number[][]) => ring.slice(0, -1);

  const signedArea = (ring: number[][]) =>
    ring.slice(0, -1).reduce((sum, [x1, y1], i) => {
      const [x2, y2] = ring[i + 1]!;
      return sum + x1! * y2! - x2! * y1!;
    }, 0);

  async function run(polygons: unknown) {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ isolines: [{ range: { type: 'time', value: 600 }, polygons }] }),
        { status: 200 },
      ),
    );
    return new HereIsochroneConnector(defaultConfig).isochrone({
      center: { lat: 5, lng: 5 },
      type: 'time',
      values: [600],
    });
  }

  it('returns a MultiPolygon with every part when an isoline has several polygons', async () => {
    const result = await run([
      { outer: flex(open(A_CCW)), inner: [flex(open(HOLE_A_CCW))] },
      { outer: flex(open(B_CCW)) },
    ]);
    expect(result.contours[0]!.geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[A_CCW, cw(HOLE_A_CCW)], [B_CCW]],
    });
  });

  it('keeps a single part a Polygon, with its hole, winding normalized', async () => {
    // Exterior sent clockwise and hole counter-clockwise: both must flip.
    const result = await run([{ outer: flex(open(cw(A_CCW))), inner: [flex(open(HOLE_A_CCW))] }]);
    const geometry = result.contours[0]!.geometry;
    expect(geometry.type).toBe('Polygon');
    const [exterior, hole] = geometry.coordinates as number[][][];
    expect(signedArea(exterior!)).toBeGreaterThan(0);
    expect(signedArea(hole!)).toBeLessThan(0);
    expect(exterior![0]).toEqual(exterior![exterior!.length - 1]);
    expect(hole![0]).toEqual(hole![hole!.length - 1]);
    expect(geometry.coordinates).toHaveLength(2);
  });

  it.each([
    ['a part without an outer ring', [{ inner: [] }, { outer: flex(open(A_CCW)) }]],
    ['a part with an empty outer ring', [{ outer: '' }, { outer: flex(open(A_CCW)) }]],
    ['a part with an undecodable outer ring', [{ outer: flex(open(A_CCW)) }, { outer: 'B' }]],
    ['an inner that is not a list', [{ outer: flex(open(A_CCW)), inner: 'x' }]],
    ['an inner entry that is not a string', [{ outer: flex(open(A_CCW)), inner: [1] }]],
    ['an undecodable inner entry', [{ outer: flex(open(A_CCW)), inner: ['!!'] }]],
  ])('drops %s and keeps the usable rest', async (_label, polygons) => {
    const result = await run(polygons);
    expect(result.contours[0]!.geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW] });
  });

  it.each([
    ['an empty polygons list', []],
    ['no usable part at all', [{ outer: '' }, { inner: [flex(open(HOLE_A_CCW))] }]],
  ])('raises unknown for %s', async (_label, polygons) => {
    await expect(run(polygons)).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
  });
});
