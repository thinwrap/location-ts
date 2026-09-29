import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriIsochroneConnector } from './esri.isochrone.connector';
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

function buildServiceAreaResponse() {
  return new Response(
    JSON.stringify({
      saPolygons: {
        features: [
          {
            attributes: { FromBreak: 10, ToBreak: 20 },
            geometry: {
              rings: [[[-74.02, 40.70], [-73.98, 40.73], [-74.02, 40.70]]],
            },
          },
          {
            attributes: { FromBreak: 0, ToBreak: 10 },
            geometry: {
              rings: [[[-74.006, 40.7128], [-73.99, 40.72], [-74.006, 40.7128]]],
            },
          },
        ],
      },
    }),
    { status: 200 },
  );
}

describe('EsriIsochroneConnector', () => {
  let connector: EsriIsochroneConnector;

  beforeEach(() => {
    connector = new EsriIsochroneConnector(defaultConfig);
  });

  it('should have providerId "esri"', () => {
    expect(connector.providerId).toBe('esri');
  });

  it('should POST form-encoded ServiceArea with time breaks in minutes', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600, 1200], // 10min, 20min in seconds
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('solveServiceArea');
    expect(url as string).toContain('route-api.arcgis.com');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toContain(
      'application/x-www-form-urlencoded',
    );

    const params = new URLSearchParams(init!.body as string);
    expect(params.get('f')).toBe('json');
    expect(params.get('token')).toBe('esri-test-token');
    expect(params.get('defaultBreaks')).toBe('10,20');
    // solveServiceArea has no breakUnits parameter; minutes follow from the
    // default TravelTime impedance, which is therefore left unset.
    expect(params.get('breakUnits')).toBeNull();
    expect(params.get('impedanceAttributeName')).toBeNull();
    expect(params.get('travelDirection')).toBe('esriNATravelDirectionFromFacility');

    const facilities = JSON.parse(params.get('facilities')!);
    expect(facilities.features[0].geometry.x).toBe(-74.006);
    expect(facilities.features[0].geometry.y).toBe(40.7128);
    expect(facilities.features[0].geometry.spatialReference.wkid).toBe(4326);

    // Contours sorted ascending and converted back to seconds.
    expect(result.contours).toHaveLength(2);
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[1]!.value).toBe(1200);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
    expect((result.contours[0]!.geometry as { coordinates: number[][][] }).coordinates[0]).toEqual([
      [-74.006, 40.7128],
      [-73.99, 40.72],
      [-74.006, 40.7128],
    ]);
  });

  it('driving distance: sends km breaks with a Kilometers impedance and returns meters', async () => {
    // ToBreak comes back in the impedance's unit — kilometers here.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          saPolygons: {
            features: [
              { attributes: { FromBreak: 1, ToBreak: 2.5 }, geometry: { rings: [[[0, 0], [1, 1], [0, 0]]] } },
              { attributes: { FromBreak: 0, ToBreak: 1.1 }, geometry: { rings: [[[0, 0], [2, 2], [0, 0]]] } },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'distance',
      values: [1100, 2500],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('defaultBreaks')).toBe('1.1,2.5');
    expect(params.get('impedanceAttributeName')).toBe('Kilometers');
    expect(params.get('breakUnits')).toBeNull();
    expect(params.get('travelMode')).toBeNull();
    expect(result.contours.map((c) => c.value)).toEqual([1100, 2500]);
  });

  it('walking distance: carries the Kilometers impedance inside the walking travel mode', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'distance',
      values: [2000],
      travelMode: 'walking',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('defaultBreaks')).toBe('2');
    expect(params.get('breakUnits')).toBeNull();
    // A travel mode overrides the request-level impedanceAttributeName, so it
    // must not be relied on (or sent) here.
    expect(params.get('impedanceAttributeName')).toBeNull();
    // Esri's published World "Walking Distance" mode, not a relabelled
    // "Walking Time" (id caFAgoThrvUpkFBW).
    const travelMode = JSON.parse(params.get('travelMode') as string);
    expect(travelMode.id).toBe('yFuMFwIYblqKEefX');
    expect(travelMode.type).toBe('WALK');
    expect(travelMode.impedanceAttributeName).toBe('Kilometers');
    expect(travelMode.distanceAttributeName).toBe('Kilometers');
    expect(travelMode.timeAttributeName).toBe('WalkTime');
    expect(travelMode.name).toBe('Walking Distance');
    expect(travelMode.description).toContain('optimize travel distance');
  });

  it('time isochrones keep the minute breaks and walk-time impedance', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'walking',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('defaultBreaks')).toBe('10');
    expect(params.get('impedanceAttributeName')).toBeNull();
    expect(JSON.parse(params.get('travelMode') as string).impedanceAttributeName).toBe('WalkTime');
  });

  describe('outputPolygons (detailed limit: 15 minutes / 15 miles)', () => {
    const cases: Array<{ type: 'time' | 'distance'; values: number[]; expected: string }> = [
      { type: 'time', values: [600], expected: 'esriNAOutputPolygonDetailed' },
      { type: 'time', values: [900], expected: 'esriNAOutputPolygonDetailed' },
      { type: 'time', values: [1800], expected: 'esriNAOutputPolygonSimplified' },
      { type: 'time', values: [600, 1800], expected: 'esriNAOutputPolygonSimplified' },
      { type: 'distance', values: [24140], expected: 'esriNAOutputPolygonDetailed' },
      { type: 'distance', values: [30000], expected: 'esriNAOutputPolygonSimplified' },
    ];
    for (const c of cases) {
      it(`${c.type} ${c.values.join(',')} -> ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());
        await connector.isochrone({ center: { lat: 0, lng: 0 }, type: c.type, values: c.values });
        const [, init] = mockFetch.mock.calls[0]!;
        expect(new URLSearchParams(init!.body as string).get('outputPolygons')).toBe(c.expected);
      });
    }
  });

  describe('departureTime → timeOfDay', () => {
    it('sends timeOfDay as epoch ms with timeOfDayIsUTC=true', async () => {
      mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

      await connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
        departureTime: '2024-01-15T08:00:00Z',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams(init!.body as string);
      expect(params.get('timeOfDay')).toBe('1705305600000');
      // timeOfDayIsUTC defaults to false = the facility's local time zone.
      expect(params.get('timeOfDayIsUTC')).toBe('true');
    });

    it('sends no time parameters without a departureTime', async () => {
      mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());
      await connector.isochrone({ center: { lat: 0, lng: 0 }, type: 'time', values: [600] });
      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams(init!.body as string);
      expect(params.get('timeOfDay')).toBeNull();
      expect(params.get('timeOfDayIsUTC')).toBeNull();
    });

    it('rejects an unparseable departureTime with invalid_request (no fetch)', async () => {
      await expect(
        connector.isochrone({
          center: { lat: 0, lng: 0 },
          type: 'time',
          values: [600],
          departureTime: 'next tuesday',
        }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('should pass the full Walking Time travelMode JSON object for walking', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'walking',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    // ArcGIS requires a full travel-mode JSON object, not a name string
    // (a bare "Walking Time" is ignored and the service stays on driving).
    const travelMode = JSON.parse(params.get('travelMode') as string);
    expect(travelMode.type).toBe('WALK');
    expect(travelMode.impedanceAttributeName).toBe('WalkTime');
    expect(travelMode.name).toBe('Walking Time');
  });

  it('should accept arcgisToken alternative auth (dual-auth XOR)', async () => {
    const tokenConn = new EsriIsochroneConnector({ arcgisToken: 'oauth-token' });
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await tokenConn.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('token')).toBe('oauth-token');
  });

  it('should throw on dual-auth XOR violation (both set)', async () => {
    const badConn = new EsriIsochroneConnector({
      apiKey: 'k',
      arcgisToken: 't',
    });

    await expect(
      badConn.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should enforce the 4-value cap', async () => {
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [60, 120, 180, 240, 300],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should throw ConnectorError on 200 with error body (ESRI quirk)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Token invalid', code: 498 },
        }),
        { status: 200 },
      ),
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
    expect(e.providerCode).toBe('auth_failed');
    expect(e.providerMessage).toContain('Token invalid');
  });

  it('should throw ConnectorError on transport error (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'provider_unavailable' });
  });

  // A genuine HTTP 429 must classify as rate_limited EVEN when the body carries
  // an error code that would otherwise fall through to the generic 'unknown'
  // mapping: the status check runs before the in-body branch.
  it('should map HTTP 429 with a generic in-body error code to rate_limited (429-precedence)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'Too Many Requests', code: 12345 } }),
        { status: 429 },
      ),
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
    expect((caught as ConnectorError).statusCode).toBe(429);
    expect((caught as ConnectorError).providerCode).toBe('rate_limited');
  });

  it('should map HTTP 429 with no in-body error code to rate_limited (429-precedence)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Too Many Requests' }), {
        status: 429,
      }),
    );
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'rate_limited' });
  });

  it('should convert minutes back to seconds on output contours', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          saPolygons: {
            features: [
              {
                attributes: { FromBreak: 0, ToBreak: 5 }, // 5 minutes
                geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
    });

    expect(result.contours[0]!.value).toBe(300); // 5 min × 60 = 300s
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

  describe('break values', () => {
    function saResp(toBreaks: number[]): Response {
      return new Response(
        JSON.stringify({
          saPolygons: {
            features: toBreaks.map((ToBreak) => ({
              attributes: { FromBreak: 0, ToBreak },
              geometry: { rings: [[[0, 0], [1, 0], [0, 0]]] },
            })),
          },
        }),
        { status: 200 },
      );
    }

    // 7 s goes out as 0.116667 min; scaling the echo back would report 7.00002 s.
    it('reports the caller value for each break ESRI echoes', async () => {
      mockFetch.mockResolvedValueOnce(saResp([0.116667, 1.1]));
      const connector = new EsriIsochroneConnector(defaultConfig);
      const result = await connector.isochrone({
        center: { lat: 1, lng: 2 },
        type: 'time',
        values: [7, 66],
      });
      expect(result.contours.map((c) => c.value)).toEqual([7, 66]);
    });

    it('does the same for distance breaks', async () => {
      mockFetch.mockResolvedValueOnce(saResp([0.0003]));
      const connector = new EsriIsochroneConnector(defaultConfig);
      const result = await connector.isochrone({
        center: { lat: 1, lng: 2 },
        type: 'distance',
        values: [0.3],
      });
      const form = new URLSearchParams(mockFetch.mock.calls[0]![1]!.body as string);
      expect(form.get('defaultBreaks')).toBe('0.0003');
      expect(result.contours[0]!.value).toBe(0.3);
    });

    it.each([
      ['no polygons', { saPolygons: { features: [] } }],
      ['no saPolygons at all', {}],
      ['a polygon without rings', { saPolygons: { features: [{ attributes: { ToBreak: 1 }, geometry: {} }] } }],
      [
        'a polygon without ToBreak',
        { saPolygons: { features: [{ attributes: {}, geometry: { rings: [[[0, 0], [1, 1]]] } }] } },
      ],
      [
        'a point missing a coordinate',
        { saPolygons: { features: [{ attributes: { ToBreak: 1 }, geometry: { rings: [[[0], [1, 1]]] } }] } },
      ],
    ])('raises unknown for %s', async (_label, body) => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      const connector = new EsriIsochroneConnector(defaultConfig);
      await expect(
        connector.isochrone({ center: { lat: 1, lng: 2 }, type: 'time', values: [60] }),
      ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
    });
  });
});

describe('EsriIsochroneConnector — multi-part polygons, holes and winding', () => {
  // [lng, lat] squares. Esri winds exteriors clockwise and holes counter-clockwise.
  const A_CCW = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const HOLE_A_CCW = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
  const B_CCW = [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]];
  const HOLE_B_CCW = [[22, 2], [24, 2], [24, 4], [22, 4], [22, 2]];
  const cw = (ring: number[][]) => [...ring].reverse();

  /** Twice the signed area: positive = counter-clockwise (RFC 7946 exterior). */
  const signedArea = (ring: number[][]) =>
    ring.slice(0, -1).reduce((sum, [x1, y1], i) => {
      const [x2, y2] = ring[i + 1]!;
      return sum + x1! * y2! - x2! * y1!;
    }, 0);

  function respond(rings: number[][][]) {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          saPolygons: { features: [{ attributes: { FromBreak: 0, ToBreak: 10 }, geometry: { rings } }] },
        }),
        { status: 200 },
      ),
    );
  }

  async function geometryFor(rings: number[][][]) {
    respond(rings);
    const result = await new EsriIsochroneConnector(defaultConfig).isochrone({
      center: { lat: 5, lng: 5 },
      type: 'time',
      values: [600],
    });
    return result.contours[0]!.geometry;
  }

  it('returns a MultiPolygon holding both exteriors, each with its own hole, when rings[0] is a hole', async () => {
    const geometry = await geometryFor([HOLE_B_CCW, cw(A_CCW), HOLE_A_CCW, cw(B_CCW)]);
    expect(geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [A_CCW, cw(HOLE_A_CCW)],
        [B_CCW, cw(HOLE_B_CCW)],
      ],
    });
  });

  it('keeps a single exterior a Polygon, with its hole, and never takes rings[0] as the exterior', async () => {
    const geometry = await geometryFor([HOLE_A_CCW, cw(A_CCW)]);
    expect(geometry.type).toBe('Polygon');
    const [exterior, hole, ...rest] = geometry.coordinates as number[][][];
    expect(rest).toHaveLength(0);
    expect(exterior).toEqual(A_CCW);
    expect(hole).toEqual(cw(HOLE_A_CCW));
    // RFC 7946: exterior counter-clockwise, hole clockwise.
    expect(signedArea(exterior!)).toBeGreaterThan(0);
    expect(signedArea(hole!)).toBeLessThan(0);
  });

  it('closes an open ring', async () => {
    const geometry = await geometryFor([cw(A_CCW).slice(0, -1)]);
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW] });
  });

  it('attaches a hole no exterior contains to the largest exterior', async () => {
    const small = [[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]];
    const stray = [[70, 70], [71, 70], [71, 71], [70, 71], [70, 70]];
    const geometry = await geometryFor([cw(small), cw(A_CCW), stray]);
    expect(geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [[small], [A_CCW, cw(stray)]],
    });
  });

  it('attaches a hole to the smallest exterior containing it (an island inside a hole)', async () => {
    const island = [[2.5, 2.5], [3.5, 2.5], [3.5, 3.5], [2.5, 3.5], [2.5, 2.5]];
    const lakeOnIsland = [[2.8, 2.8], [3.2, 2.8], [3.2, 3.2], [2.8, 3.2], [2.8, 2.8]];
    const geometry = await geometryFor([cw(A_CCW), HOLE_A_CCW, cw(island), lakeOnIsland]);
    expect(geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [A_CCW, cw(HOLE_A_CCW)],
        [island, cw(lakeOnIsland)],
      ],
    });
  });

  it('reads every ring as an exterior when none is clockwise (convention not followed)', async () => {
    const geometry = await geometryFor([A_CCW, B_CCW]);
    expect(geometry).toEqual({ type: 'MultiPolygon', coordinates: [[A_CCW], [B_CCW]] });
  });

  it('drops an empty or malformed ring and keeps the usable rest', async () => {
    const geometry = await geometryFor([[], [[0], [1, 1]], 'x' as unknown as number[][], cw(A_CCW)]);
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [A_CCW] });
  });

  it('keeps a zero-area ring as an exterior rather than dropping it', async () => {
    const sliver = [[40, 40], [41, 41], [40, 40]];
    const geometry = await geometryFor([cw(A_CCW), sliver]);
    expect(geometry).toEqual({ type: 'MultiPolygon', coordinates: [[A_CCW], [sliver]] });
  });

  it('raises unknown when every ring is empty', async () => {
    respond([[], []]);
    await expect(
      new EsriIsochroneConnector(defaultConfig).isochrone({
        center: { lat: 5, lng: 5 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
  });
});
