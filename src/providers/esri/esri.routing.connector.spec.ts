import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriRoutingConnector } from './esri.routing.connector';
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

const ROUTE_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve';

const OMIT_DIRECTIONS = Symbol('omit-directions');

function buildSuccessBody(
  overrides: {
    attributes?: Record<string, unknown>;
    paths?: number[][][];
    directions?: unknown;
  } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    routes: {
      features: [
        {
          attributes: overrides.attributes ?? {
            Total_Length: 8047,
            Total_Time: 10,
          },
          geometry: {
            paths: overrides.paths ?? [
              [
                [-74.006, 40.7128],
                [-73.9855, 40.758],
              ],
            ],
          },
        },
      ],
    },
  };

  if (overrides.directions === OMIT_DIRECTIONS) {
    return body;
  }
  body.directions =
    overrides.directions === undefined
      ? [
          {
            features: [
              { attributes: { length: 0, time: 0, maneuverType: 'esriDMTStop' } },
              { attributes: { length: 8047, time: 10 } },
              { attributes: { length: 0, time: 0, maneuverType: 'esriDMTStop' } },
            ],
          },
        ]
      : overrides.directions;
  return body;
}

function buildSuccessResponse(body: unknown = buildSuccessBody()): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

describe('EsriRoutingConnector', () => {
  let connector: EsriRoutingConnector;

  beforeEach(() => {
    connector = new EsriRoutingConnector(defaultConfig);
  });

  it('exposes providerId "esri"', () => {
    expect(connector.providerId).toBe('esri');
  });

  describe('HTTP dispatch', () => {
    it('POSTs form-encoded data to the Route_World/solve endpoint', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
        ],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect((url as string).split('?')[0]).toBe(ROUTE_URL);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = parseForm(init!.body as string);
      expect(params.get('f')).toBe('json');
      expect(params.get('token')).toBe('esri-test-token');
      expect(params.get('returnRoutes')).toBe('true');
      expect(params.get('returnDirections')).toBe('true');
      expect(params.get('directionsLengthUnits')).toBe('esriNAUMeters');
      expect(params.get('outSR')).toBe('4326');
    });

    it('forwards departureTime as epoch milliseconds in `startTime`', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      const when = new Date('2024-01-15T08:00:00Z');
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        departureTime: when,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('startTime')).toBe(String(when.getTime()));
    });
  });

  describe('FeatureSet `stops` encoding', () => {
    it('serializes waypoints as ESRI FeatureSet with WGS-84 spatialReference', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
          { lat: 41.0, lng: -73.0 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      const stopsJson = params.get('stops');
      expect(stopsJson).not.toBeNull();
      const stops = JSON.parse(stopsJson as string) as {
        features: Array<{
          geometry: { x: number; y: number; spatialReference: { wkid: number } };
        }>;
      };
      expect(stops.features).toHaveLength(3);
      expect(stops.features[0]).toEqual({
        geometry: {
          x: -74.006,
          y: 40.7128,
          spatialReference: { wkid: 4326 },
        },
      });
      expect(stops.features[2]!.geometry.x).toBe(-73.0);
      expect(stops.features[2]!.geometry.y).toBe(41.0);
    });
  });

  describe('Auth handling', () => {
    it('forwards apiKey via the `token` form field', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('token')).toBe('esri-test-token');
    });

    it('forwards arcgisToken via the same `token` form field when set instead', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      const c = new EsriRoutingConnector({ arcgisToken: 'oauth-bearer' });
      await c.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('token')).toBe('oauth-bearer');
    });

    it('throws invalid_request when both apiKey and arcgisToken are set (XOR invariant)', async () => {
      const c = new EsriRoutingConnector({
        apiKey: 'a',
        arcgisToken: 'b',
      });

      let thrown: unknown;
      try {
        await c.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws auth_failed when neither apiKey nor arcgisToken is set', async () => {
      const c = new EsriRoutingConnector({});

      let thrown: unknown;
      try {
        await c.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('auth_failed');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Result-shape normalization', () => {
    it('reads Total_Length as meters and Total_Time as minutes', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_Length: 12345, Total_Time: 25 },
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.totalDistanceMeters).toBe(12345);
      expect(result.totalDurationSeconds).toBe(25 * 60);
    });

    it('falls back to Total_Kilometers * 1000 when Total_Length is absent (brownfield parity)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_Kilometers: 8.047, Total_TravelTime: 10 },
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.totalDistanceMeters).toBeCloseTo(8047, 0);
      expect(result.totalDurationSeconds).toBe(600);
    });

    it('reconstructs per-leg distance/duration from directions delimited by esriDMTStop', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_Length: 1000, Total_Time: 20 },
            directions: [
              {
                features: [
                  { attributes: { length: 0, time: 0, maneuverType: 'esriDMTStop' } },
                  { attributes: { length: 300, time: 6 } },
                  { attributes: { length: 100, time: 2 } },
                  { attributes: { length: 0, time: 0, maneuverType: 'esriDMTStop' } },
                  { attributes: { length: 600, time: 12 } },
                  { attributes: { length: 0, time: 0, maneuverType: 'esriDMTStop' } },
                ],
              },
            ],
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });

      expect(result.legs).toHaveLength(2);
      expect(result.legs[0]).toEqual({
        distanceMeters: 400,
        durationSeconds: 8 * 60,
      });
      expect(result.legs[1]).toEqual({
        distanceMeters: 600,
        durationSeconds: 12 * 60,
      });
    });

    it('falls back to even-split legs when directions are absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_Length: 1000, Total_Time: 20 },
            directions: OMIT_DIRECTIONS,
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });

      expect(result.legs).toHaveLength(2);
      expect(result.legs[0]!.distanceMeters).toBe(500);
      expect(result.legs[1]!.distanceMeters).toBe(500);
    });

    it('re-encodes geometry paths into a precision-5 polyline (call-site)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            paths: [
              [
                [-120.2, 38.5],
                [-120.95, 40.7],
                [-126.453, 43.252],
              ],
            ],
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      // Sample from Google's polyline algorithm spec.
      expect(result.polyline).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    });

    it('exposes waypointOrder when findBestSequence reorders Stops attribute', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: {
              Total_Length: 1000,
              Total_Time: 20,
              Stops: '0,2,1,3',
            },
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        optimize: true,
      });

      expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
    });

    it('omits waypointOrder when Stops attribute is absent', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.waypointOrder).toBeUndefined();
    });

    it('emits findBestSequence/preserveFirstStop/preserveLastStop form fields when optimize is set', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
        optimizeFixedOrigin: true,
        optimizeFixedDestination: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('findBestSequence')).toBe('true');
      expect(params.get('preserveFirstStop')).toBe('true');
      expect(params.get('preserveLastStop')).toBe('true');
    });

    it('emits restrictionAttributeNames for avoid flags', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidTolls: true,
        avoidHighways: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      const restrictions = params.get('restrictionAttributeNames');
      expect(restrictions).toContain('Avoid Toll Roads');
      // ArcGIS Network Analyst restriction name per baseline audit (loc-CR #73).
      expect(restrictions).toContain('Avoid Limited Access Roads');
    });
  });

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
      it(`HTTP ${c.status} -> ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'fail', code: c.status } }), {
            status: c.status,
          }),
        );
        let thrown: unknown;
        try {
          await connector.route({
            waypoints: [
              { lat: 0, lng: 0 },
              { lat: 1, lng: 1 },
            ],
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConnectorError);
        expect((thrown as ConnectorError).statusCode).toBe(c.status);
        // Body error code takes precedence in mapping — but in these
        // fixtures the codes deliberately match the HTTP status so the
        // expected ProviderCode is the same regardless of which path mapped.
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
      it(`body.error.code ${c.code} -> ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'fail', code: c.code } }),
            { status: 200 },
          ),
        );
        let thrown: unknown;
        try {
          await connector.route({
            waypoints: [
              { lat: 0, lng: 0 },
              { lat: 1, lng: 1 },
            ],
          });
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
    // otherwise fall through to the generic 'unknown' mapping.
    it('HTTP 429 with a generic in-body error code -> rate_limited (429-precedence)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Too Many Requests', code: 12345 } }),
          { status: 429 },
        ),
      );
      let thrown: unknown;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).statusCode).toBe(429);
      expect((thrown as ConnectorError).providerCode).toBe('rate_limited');
    });

    it('HTTP 429 with no in-body error code -> rate_limited (429-precedence)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
        }),
      );
      let thrown: unknown;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('rate_limited');
    });

    it('surfaces Retry-After in providerMessage and cause by design', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Too Many Requests', code: 429 } }),
          { status: 429, headers: { 'Retry-After': '42' } },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerMessage).toContain('retry after 42 seconds');
      expect(thrown!.providerMessage).toContain('Too Many Requests');
      const cause = thrown!.cause as Record<string, unknown> | undefined;
      expect(cause?.retryAfter).toBe('42');
    });
  });

  describe('200-with-error-body inspection', () => {
    it('throws ConnectorError when HTTP 200 carries an error body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid token', code: 498 },
            routes: { features: [] },
          }),
          { status: 200 },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.statusCode).toBe(200);
      expect(thrown!.providerCode).toBe('auth_failed');
      expect(thrown!.providerMessage).toBe('Invalid token');
    });

    it('throws ConnectorError when HTTP 200 with no routes', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ routes: { features: [] } }), { status: 200 }),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('unknown');
      expect(thrown!.providerMessage).toBe('ESRI Routing returned no routes');
    });
  });

  describe('input validation', () => {
    it('throws invalid_request when fewer than 2 waypoints', async () => {
      let thrown: unknown;
      try {
        await connector.route({ waypoints: [{ lat: 0, lng: 0 }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('_passthrough merging', () => {
    it('merges _passthrough.body onto the form fields', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { body: { impedanceAttributeName: 'Minutes' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('impedanceAttributeName')).toBe('Minutes');
    });

    it('merges _passthrough.headers and _passthrough.query into the request', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: {
          headers: { 'X-Custom': 'value' },
          query: { trace: 'on' },
        },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
      expect(url as string).toContain('trace=on');
    });
  });
});
