import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TomTomRoutingConnector } from './tomtom.routing.connector';
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

const ROUTE_BASE = 'https://api.tomtom.com/routing/1/calculateRoute';

function buildRouteBody(opts?: { optimized?: boolean }) {
  return {
    routes: [
      {
        summary: { lengthInMeters: 8000, travelTimeInSeconds: 480 },
        legs: [
          {
            summary: { lengthInMeters: 5000, travelTimeInSeconds: 300 },
            points: [
              { latitude: 40.7128, longitude: -74.006 },
              { latitude: 40.73, longitude: -73.995 },
            ],
          },
          {
            summary: { lengthInMeters: 3000, travelTimeInSeconds: 180 },
            points: [
              { latitude: 40.73, longitude: -73.995 },
              { latitude: 40.758, longitude: -73.9855 },
            ],
          },
        ],
      },
    ],
    ...(opts?.optimized
      ? {
          optimizedWaypoints: [
            { providedIndex: 1, optimizedIndex: 0 },
            { providedIndex: 0, optimizedIndex: 1 },
          ],
        }
      : {}),
  };
}

function buildRouteResponse(opts?: { optimized?: boolean }): Response {
  return new Response(JSON.stringify(buildRouteBody(opts)), { status: 200 });
}

function urlOf(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex]![0] as string;
}

function initOf(callIndex = 0): RequestInit {
  return mockFetch.mock.calls[callIndex]![1] as RequestInit;
}

function queryOf(callIndex = 0): URLSearchParams {
  const url = urlOf(callIndex);
  const qs = url.split('?')[1] ?? '';
  return new URLSearchParams(qs);
}

describe('TomTomRoutingConnector', () => {
  let connector: TomTomRoutingConnector;

  beforeEach(() => {
    connector = new TomTomRoutingConnector(defaultConfig);
  });

  it('exposes providerId "tomtom"', () => {
    expect(connector.providerId).toBe('tomtom');
  });

  describe('HTTP dispatch ', () => {
    it('GETs calculateRoute with colon-separated lat,lng path coordinates', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.73, lng: -73.995 },
          { lat: 40.758, lng: -73.9855 },
        ],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = urlOf();
      const init = initOf();

      // Path: /routing/1/calculateRoute/{locations}/json
      expect(url.startsWith(`${ROUTE_BASE}/`)).toBe(true);
      const pathSegment = url.slice(`${ROUTE_BASE}/`.length).split('?')[0]!;
      expect(pathSegment).toBe(
        '40.7128,-74.006:40.73,-73.995:40.758,-73.9855/json',
      );
      expect(init?.method).toBe('GET');

      const q = queryOf();
      expect(q.get('key')).toBe('test-key');
      expect(q.get('travelMode')).toBe('car');
      expect(q.get('routeType')).toBe('fastest');
      expect(q.get('routeRepresentation')).toBe('polyline');
    });

    it('forwards departureTime as ISO-8601 in `departAt`', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const when = new Date('2024-06-15T08:00:00Z');
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        departureTime: when,
      });

      expect(queryOf().get('departAt')).toBe(when.toISOString());
    });

    it('maps travel modes: driving → car, walking → pedestrian, cycling → bicycle', async () => {
      const cases: Array<{
        mode: 'driving' | 'walking' | 'cycling' | undefined;
        expected: string;
      }> = [
        { mode: undefined, expected: 'car' },
        { mode: 'driving', expected: 'car' },
        { mode: 'walking', expected: 'pedestrian' },
        { mode: 'cycling', expected: 'bicycle' },
      ];

      for (const c of cases) {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(buildRouteResponse());

        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          travelMode: c.mode,
        });

        expect(queryOf().get('travelMode')).toBe(c.expected);
      }
    });
  });

  describe('Avoid options mapping ', () => {
    it('maps avoidTolls → tollRoads', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidTolls: true,
      });

      expect(queryOf().get('avoid')).toBe('tollRoads');
    });

    it('maps avoidFerries → ferries', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidFerries: true,
      });

      expect(queryOf().get('avoid')).toBe('ferries');
    });

    it('maps avoidHighways → motorways', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidHighways: true,
      });

      expect(queryOf().get('avoid')).toBe('motorways');
    });

    it('comma-joins multiple avoid values in `avoid=`', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidTolls: true,
        avoidFerries: true,
        avoidHighways: true,
      });

      expect(queryOf().get('avoid')).toBe('tollRoads,ferries,motorways');
    });

    it('omits `avoid` when no avoid flags are set', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(queryOf().has('avoid')).toBe(false);
    });
  });

  describe('Result-shape normalization ', () => {
    it('reads totals from summary.lengthInMeters and summary.travelTimeInSeconds', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.73, lng: -73.995 },
          { lat: 40.758, lng: -73.9855 },
        ],
      });

      expect(result.totalDistanceMeters).toBe(8000);
      expect(result.totalDurationSeconds).toBe(480);
    });

    it('maps each leg via summary.lengthInMeters + summary.travelTimeInSeconds', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.73, lng: -73.995 },
          { lat: 40.758, lng: -73.9855 },
        ],
      });

      expect(result.legs).toHaveLength(2);
      expect(result.legs[0]).toEqual({ distanceMeters: 5000, durationSeconds: 300 });
      expect(result.legs[1]).toEqual({ distanceMeters: 3000, durationSeconds: 180 });
    });

    it('re-encodes leg points (latitude/longitude full-word keys) into precision-5 polyline', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            routes: [
              {
                summary: { lengthInMeters: 0, travelTimeInSeconds: 0 },
                legs: [
                  {
                    summary: { lengthInMeters: 0, travelTimeInSeconds: 0 },
                    points: [
                      { latitude: 38.5, longitude: -120.2 },
                      { latitude: 40.7, longitude: -120.95 },
                      { latitude: 43.252, longitude: -126.453 },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      // Sample from Google's polyline algorithm spec (precision-5).
      expect(result.polyline).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    });

    it('exposes raw response body on result.raw', async () => {
      const body = buildRouteBody();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.raw).toEqual(body);
    });

    it('sends computeBestOrder=true when optimize is set with >2 waypoints', async () => {
      // Input [A,B,C,D]; origin A(0) and destination D(3) are fixed; only the
      // 2 intermediates B(1),C(2) are reordered. TomTom's optimizedWaypoints
      // covers ONLY those intermediates, providedIndex 0-based over them:
      // sorted by optimizedIndex → providedIndex [1,0] → input indices [2,1].
      mockFetch.mockResolvedValueOnce(buildRouteResponse({ optimized: true }));

      const result = await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.73, lng: -73.995 },
          { lat: 40.758, lng: -73.9855 },
          { lat: 40.77, lng: -73.98 },
        ],
        optimize: true,
      });

      expect(queryOf().get('computeBestOrder')).toBe('true');
      // Canonical waypointOrder = full visiting sequence of INPUT indices with
      // the fixed origin (0) and destination (N-1) bracketing the projected
      // intermediates.
      expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
    });

    // Cross-language canonical waypointOrder parity fixture. Logical input
    // [A,B,C,D,E]; origin A(0)/destination E(4) fixed; intermediates B,C,D
    // (input 1,2,3, providedIndex 0,1,2) reordered to visit D,B,C. TomTom's
    // optimizedWaypoints (intermediate-relative) → projected to input indices,
    // bracketed by origin/destination, yields canonical [0,3,1,2,4].
    it('canonical waypointOrder: full visiting sequence of input indices', async () => {
      const body = {
        ...buildRouteBody(),
        optimizedWaypoints: [
          { providedIndex: 2, optimizedIndex: 0 },
          { providedIndex: 0, optimizedIndex: 1 },
          { providedIndex: 1, optimizedIndex: 2 },
        ],
      };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
          { lat: 4, lng: 4 },
        ],
        optimize: true,
      });

      expect(result.waypointOrder).toEqual([0, 3, 1, 2, 4]);
    });

    // TomTom projects `providedIndex + 1` the same way Google projects its
    // intermediate indices, so it carries the same corruption risk: any
    // ordering that is not a complete permutation of the input indices must be
    // omitted rather than emitted with a dropped or repeated waypoint.
    it.each([
      ['a short intermediate list', [{ providedIndex: 0, optimizedIndex: 0 }]],
      [
        'duplicate providedIndex values',
        [
          { providedIndex: 0, optimizedIndex: 0 },
          { providedIndex: 0, optimizedIndex: 1 },
        ],
      ],
      [
        'an out-of-range providedIndex',
        [
          { providedIndex: 9, optimizedIndex: 0 },
          { providedIndex: 0, optimizedIndex: 1 },
        ],
      ],
      [
        'a -1 sentinel providedIndex',
        [
          { providedIndex: -1, optimizedIndex: 0 },
          { providedIndex: 0, optimizedIndex: 1 },
        ],
      ],
      [
        'a providedIndex colliding with the destination',
        [
          { providedIndex: 2, optimizedIndex: 0 },
          { providedIndex: 0, optimizedIndex: 1 },
        ],
      ],
    ])('omits waypointOrder for %s', async (_label, optimizedWaypoints) => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...buildRouteBody(), optimizedWaypoints }),
          { status: 200 },
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

      expect(result.waypointOrder).toBeUndefined();
      // The route itself is still returned.
      expect(result.totalDistanceMeters).toBe(8000);
    });

    it('omits computeBestOrder when optimize is set but only two waypoints', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimize: true,
      });

      expect(queryOf().has('computeBestOrder')).toBe(false);
    });

    it('omits waypointOrder when optimizedWaypoints is absent', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.waypointOrder).toBeUndefined();
    });
  });

  describe('mapVendorError ', () => {
    const httpCases: Array<{ status: number; expected: string }> = [
      { status: 400, expected: 'invalid_request' },
      { status: 401, expected: 'auth_failed' },
      { status: 403, expected: 'auth_failed' },
      { status: 404, expected: 'invalid_request' },
      { status: 429, expected: 'rate_limited' },
      { status: 500, expected: 'provider_unavailable' },
      { status: 503, expected: 'provider_unavailable' },
      { status: 418, expected: 'unknown' },
    ];

    for (const c of httpCases) {
      it(`HTTP ${c.status} -> ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { description: 'fail' } }), {
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
        expect((thrown as ConnectorError).providerCode).toBe(c.expected);
      });
    }

    it('extracts error.description into providerMessage', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { description: 'API key is invalid' },
          }),
          { status: 403 },
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
      expect(thrown!.providerMessage).toBe('API key is invalid');
    });

    it('surfaces Retry-After in providerMessage and cause by design', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { description: 'Too Many Requests' } }),
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
      // No structured retryAfterSeconds field on ConnectorError.
      expect(
        (thrown as unknown as Record<string, unknown>).retryAfterSeconds,
      ).toBeUndefined();
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

    it('throws no_route when 2xx returns no routes', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ routes: [] }), { status: 200 }),
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
      expect(thrown!.providerCode).toBe('no_route');
      expect(thrown!.providerMessage).toBe('TomTom Routing returned no routes');
    });
  });

  describe('_passthrough merging', () => {
    it('merges _passthrough.query onto the request query string', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { query: { instructionsType: 'text', language: 'en' } },
      });

      const q = queryOf();
      expect(q.get('instructionsType')).toBe('text');
      expect(q.get('language')).toBe('en');
      // Base query still carried.
      expect(q.get('key')).toBe('test-key');
      expect(q.get('travelMode')).toBe('car');
    });

    it('merges _passthrough.headers into the request headers', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { headers: { 'X-Custom': 'value' } },
      });

      const headers = initOf().headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
    });

    it('lets _passthrough.query override base query values', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { query: { routeType: 'shortest' } },
      });

      expect(queryOf().get('routeType')).toBe('shortest');
    });
  });

  // Success-path malformed body: a 200 OK whose JSON fails to parse yields null
  // via `.catch(() => null)` and must surface a typed ConnectorError rather than
  // an uncaught SyntaxError.
  describe('malformed 200 body', () => {
    it('throws ConnectorError on a non-JSON 200 body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

      let thrown: ConnectorError | null = null;
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
      expect(thrown?.providerCode).toBe('unknown');
      expect(thrown?.message).toBe('TomTom Routing returned a malformed response body');
    });
  });

  describe('malformed 200 body normalization', () => {
    // A contract-violating 200 body (route missing legs/summary) must normalize
    // to safe defaults, not escape as an unwrapped TypeError.
    it('normalizes a 200 body with a route missing legs/summary to defaults', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ routes: [{}] }), { status: 200 }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.legs).toEqual([]);
      expect(result.totalDistanceMeters).toBe(0);
      expect(result.totalDurationSeconds).toBe(0);
    });
  });
});
