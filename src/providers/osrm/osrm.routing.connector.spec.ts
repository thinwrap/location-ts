import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OsrmRoutingConnector } from './osrm.routing.connector';
import type { OsrmConfig } from './osrm.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: OsrmConfig = {
  baseUrl: 'http://localhost:5000',
};

function buildRouteResponse() {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      routes: [
        {
          geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
          legs: [
            { distance: 1000, duration: 60 },
            { distance: 2000, duration: 120 },
          ],
          distance: 3000,
          duration: 180,
        },
      ],
      waypoints: [
        { waypoint_index: 0 },
        { waypoint_index: 1 },
        { waypoint_index: 2 },
      ],
    }),
    { status: 200 },
  );
}

function buildTripResponse() {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      // The OSRM Trip service returns its route objects under `trips`.
      trips: [
        {
          geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
          legs: [
            { distance: 1500, duration: 90 },
            { distance: 2500, duration: 150 },
          ],
          distance: 4000,
          duration: 240,
        },
      ],
      waypoints: [
        { waypoint_index: 0, trips_index: 0 },
        { waypoint_index: 2, trips_index: 0 },
        { waypoint_index: 1, trips_index: 0 },
      ],
    }),
    { status: 200 },
  );
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

const TWO_WAYPOINTS = [
  { lat: 38.8977, lng: -77.0365 },
  { lat: 38.8884, lng: -77.0199 },
];

const THREE_WAYPOINTS = [
  { lat: 38.8977, lng: -77.0365 },
  { lat: 38.8884, lng: -77.0199 },
  { lat: 38.8951, lng: -77.0364 },
];

describe('OsrmRoutingConnector', () => {
  describe('Constructor — baseUrl validation', () => {
    it('exposes providerId "osrm"', () => {
      const connector = new OsrmRoutingConnector(defaultConfig);
      expect(connector.providerId).toBe('osrm');
    });

    it('throws ConnectorError when baseUrl is missing', () => {
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new OsrmRoutingConnector({} as any),
      ).toThrow(ConnectorError);
    });

    it('throws ConnectorError when baseUrl is empty string', () => {
      expect(() => new OsrmRoutingConnector({ baseUrl: '' })).toThrow(
        ConnectorError,
      );
    });

    it('throws ConnectorError when config is null', () => {
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new OsrmRoutingConnector(null as any),
      ).toThrow(ConnectorError);
    });

    it('sets providerCode invalid_request + statusCode null on baseUrl throw', () => {
      try {
        new OsrmRoutingConnector({ baseUrl: '' });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBeNull();
        expect(ce.providerMessage).toBe('baseUrl is required for OSRM');
      }
    });

    it('does not perform any HTTP call on baseUrl throw', () => {
      expect(() => new OsrmRoutingConnector({ baseUrl: '' })).toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Pre-flight validation — statusCode null, no HTTP call', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('throws unsupported_field for departureTime', async () => {
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          departureTime: new Date('2024-06-15T08:00:00Z'),
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_field');
        expect(ce.statusCode).toBeNull();
        expect(ce.providerMessage).toContain('departureTime');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws unsupported_option for avoidTolls', async () => {
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          avoidTolls: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_option');
        expect(ce.statusCode).toBeNull();
        expect(ce.providerMessage).toContain('avoidTolls');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws unsupported_option for avoidFerries', async () => {
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          avoidFerries: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_option');
        expect(ce.providerMessage).toContain('avoidFerries');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws unsupported_option for avoidHighways', async () => {
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          avoidHighways: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_option');
        expect(ce.providerMessage).toContain('avoidHighways');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws on first avoid flag when multiple are set (avoidTolls wins)', async () => {
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          avoidTolls: true,
          avoidFerries: true,
          avoidHighways: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_option');
        expect(ce.providerMessage).toContain('avoidTolls');
      }
    });

    it('remaps the otherwise-invalid open-route combo (any/any/roundtrip=false) to source=first&destination=last', async () => {
      // optimize + explicit isRoundTrip=false + neither endpoint fixed would be
      // source=any/destination=any/roundtrip=false — the combo OSRM rejects with
      // HTTP 400. The connector remaps it to first/last (open route, endpoints
      // kept, middle reordered) so the request is valid, rather than erroring.
      mockFetch.mockResolvedValueOnce(buildTripResponse());
      await connector.route({
        waypoints: THREE_WAYPOINTS,
        optimize: true,
        isRoundTrip: false,
        optimizeFixedOrigin: false,
        optimizeFixedDestination: false,
      });
      const q = queryOf();
      expect(q.get('source')).toBe('first');
      expect(q.get('destination')).toBe('last');
      expect(q.get('roundtrip')).toBe('false');
    });

    it('does NOT throw the invalid combo when only optimizeFixedOrigin is set', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());
      await expect(
        connector.route({
          waypoints: THREE_WAYPOINTS,
          optimizeFixedOrigin: true,
          isRoundTrip: false,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('/route/v1 dispatch (standard)', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('GETs /route/v1/driving with lng,lat;lng,lat coordinates', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({ waypoints: THREE_WAYPOINTS });

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = urlOf();
      expect(url).toContain(
        'http://localhost:5000/route/v1/driving/-77.0365,38.8977;-77.0199,38.8884;-77.0364,38.8951',
      );
      expect(initOf().method).toBe('GET');

      const q = queryOf();
      expect(q.get('overview')).toBe('full');
      expect(q.get('geometries')).toBe('polyline');
      expect(q.get('steps')).toBe('true');
      expect(q.get('annotations')).toBe('duration,distance');
      // Standard /route dispatch — no trip-only params.
      expect(q.get('source')).toBeNull();
      expect(q.get('destination')).toBeNull();
      expect(q.get('roundtrip')).toBeNull();

      expect(result.totalDistanceMeters).toBe(3000);
      expect(result.totalDurationSeconds).toBe(180);
      expect(result.legs).toHaveLength(2);
      expect(result.polyline).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
      expect(result.waypointOrder).toBeUndefined();
    });

    it('maps walking travel mode to "walking" profile', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: TWO_WAYPOINTS,
        travelMode: 'walking',
      });

      expect(urlOf()).toContain('/route/v1/walking/');
    });

    it('maps cycling travel mode to "cycling" profile', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: TWO_WAYPOINTS,
        travelMode: 'cycling',
      });

      expect(urlOf()).toContain('/route/v1/cycling/');
    });

    it('does not include any Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({ waypoints: TWO_WAYPOINTS });

      const init = initOf();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    });

    it('throws invalid_request when fewer than 2 waypoints', async () => {
      try {
        await connector.route({
          waypoints: [{ lat: 1, lng: 2 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBeNull();
      }
    });
  });

  describe('/trip/v1 dispatch', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('dispatches /trip/v1 + source=first&destination=last&roundtrip=false when optimize=true', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());

      const result = await connector.route({
        waypoints: THREE_WAYPOINTS,
        optimize: true,
      });

      const url = urlOf();
      expect(url).toContain('/trip/v1/driving/');
      const q = queryOf();
      // Plain optimize is an OPEN route: OSRM rejects source=any + destination=any
      // with roundtrip=false (HTTP 400), so unfixed endpoints fall back to the
      // input's first/last and only the middle is reordered — matching Mapbox v1.
      expect(q.get('source')).toBe('first');
      expect(q.get('destination')).toBe('last');
      expect(q.get('roundtrip')).toBe('false');

      expect(result.totalDistanceMeters).toBe(4000);
      // Canonical waypointOrder = full visiting sequence of INPUT indices.
      // Vendor waypoints (input order) carry waypoint_index = visit position
      // [0, 2, 1]; inverting yields visiting-order-of-input-indices [0, 2, 1].
      expect(result.waypointOrder).toEqual([0, 2, 1]);
    });

    it('uses source=first when optimizeFixedOrigin=true', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());

      await connector.route({
        waypoints: THREE_WAYPOINTS,
        optimizeFixedOrigin: true,
      });

      const q = queryOf();
      expect(q.get('source')).toBe('first');
    });

    it('uses destination=last when optimizeFixedDestination=true', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());

      await connector.route({
        waypoints: THREE_WAYPOINTS,
        optimizeFixedDestination: true,
      });

      const q = queryOf();
      expect(q.get('destination')).toBe('last');
    });

    it('sets roundtrip=true when isRoundTrip=true', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());

      await connector.route({
        waypoints: THREE_WAYPOINTS,
        isRoundTrip: true,
      });

      const q = queryOf();
      expect(q.get('roundtrip')).toBe('true');
    });

    it('combines fixed-origin + fixed-destination + roundtrip', async () => {
      mockFetch.mockResolvedValueOnce(buildTripResponse());

      await connector.route({
        waypoints: THREE_WAYPOINTS,
        optimize: true,
        optimizeFixedOrigin: true,
        optimizeFixedDestination: true,
        isRoundTrip: true,
      });

      const q = queryOf();
      expect(q.get('source')).toBe('first');
      expect(q.get('destination')).toBe('last');
      expect(q.get('roundtrip')).toBe('true');
    });

    // Cross-language canonical waypointOrder parity fixture. Logical input
    // [A,B,C,D]; optimal visiting order A,C,B,D ⇒ canonical [0,2,1,3].
    // OSRM reports waypoints[] in INPUT order with waypoint_index = visit
    // position: A→0, B→2, C→1, D→3. Inverting yields [0,2,1,3].
    it('canonical waypointOrder: full visiting sequence of input indices', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'Ok',
            // OSRM Trip service returns route objects under `trips`.
            trips: [
              {
                geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
                legs: [
                  { distance: 1, duration: 1 },
                  { distance: 1, duration: 1 },
                  { distance: 1, duration: 1 },
                ],
                distance: 3,
                duration: 3,
              },
            ],
            waypoints: [
              { waypoint_index: 0, trips_index: 0 },
              { waypoint_index: 2, trips_index: 0 },
              { waypoint_index: 1, trips_index: 0 },
              { waypoint_index: 3, trips_index: 0 },
            ],
          }),
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

      expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
    });

    // Discriminating NON-involution fixture. The fixtures above use self-inverse
    // permutations, so reverting the inverter (`order[pos] = i` → raw `[pos...]`)
    // would still pass. This vendor `waypoint_index = [1,2,0]` is a 3-cycle: its
    // inverse `[2,0,1]` differs from the raw `[1,2,0]`. Inverting per
    // `order[waypoint_index[i]] = i` gives order[1]=0, order[2]=1, order[0]=2 ⇒
    // canonical [2,0,1], LOCKING the inversion direction.
    it('locks inversion direction with a non-involution permutation', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'Ok',
            // OSRM Trip service returns route objects under `trips`.
            trips: [
              {
                geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
                legs: [
                  { distance: 1, duration: 1 },
                  { distance: 1, duration: 1 },
                ],
                distance: 2,
                duration: 2,
              },
            ],
            waypoints: [
              { waypoint_index: 1, trips_index: 0 },
              { waypoint_index: 2, trips_index: 0 },
              { waypoint_index: 0, trips_index: 0 },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
      });

      // Canonical inverse of [1,2,0] is [2,0,1] (NOT the raw [1,2,0]).
      expect(result.waypointOrder).toEqual([2, 0, 1]);
    });
  });

  describe('Result-shape normalization', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('normalizes legs distance + duration in meters/seconds (native OSRM units)', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({ waypoints: THREE_WAYPOINTS });

      expect(result.legs).toEqual([
        { distanceMeters: 1000, durationSeconds: 60 },
        { distanceMeters: 2000, durationSeconds: 120 },
      ]);
      expect(result.totalDistanceMeters).toBe(3000);
      expect(result.totalDurationSeconds).toBe(180);
    });

    it('exposes the polyline verbatim — no re-encoding (precision-5 native)', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({ waypoints: TWO_WAYPOINTS });
      expect(result.polyline).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    });

    it('exposes raw vendor body via result.raw', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({ waypoints: TWO_WAYPOINTS });
      expect((result.raw as { code: string }).code).toBe('Ok');
    });
  });

  describe('In-body OSRM status codes', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    function buildInBodyError(code: string, message = '') {
      return new Response(
        JSON.stringify({ code, message, routes: [] }),
        { status: 200 },
      );
    }

    it('maps NoRoute → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('NoRoute', 'No route'));
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.providerMessage).toBe('No route');
      }
    });

    it('maps NoSegment → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('NoSegment'));
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('maps InvalidQuery → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('InvalidQuery'));
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('maps InvalidOptions → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('InvalidOptions'));
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('maps NoTrips (trip endpoint) → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('NoTrips'));
      try {
        await connector.route({
          waypoints: THREE_WAYPOINTS,
          optimize: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('maps an unrecognized code → unknown', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('SomethingWeird'));
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unknown');
      }
    });

    it('maps NoRoute + "profile not found" message → profile_not_configured', async () => {
      mockFetch.mockResolvedValueOnce(
        buildInBodyError('NoRoute', 'profile not found for cycling'),
      );
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          travelMode: 'cycling',
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('profile_not_configured');
      }
    });

    it('does NOT auto-classify NoRoute as profile_not_configured without explicit signal', async () => {
      mockFetch.mockResolvedValueOnce(
        buildInBodyError('NoRoute', 'no route found'),
      );
      try {
        await connector.route({
          waypoints: TWO_WAYPOINTS,
          travelMode: 'cycling',
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });
  });

  describe('HTTP error mapping', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('maps HTTP 404 → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
      );
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBe(404);
      }
    });

    it('maps HTTP 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Server error' }), {
          status: 500,
        }),
      );
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('provider_unavailable');
        expect(ce.statusCode).toBe(500);
      }
    });

    it('maps HTTP 503 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 503 }),
      );
      await expect(
        connector.route({ waypoints: TWO_WAYPOINTS }),
      ).rejects.toBeInstanceOf(ConnectorError);
    });

    it('surfaces reverse-proxy 401 as auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 401 }),
      );
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
      }
    });

    it('surfaces reverse-proxy 429 as rate_limited + Retry-After in providerMessage + cause', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'slow down' }), {
          status: 429,
          headers: { 'retry-after': '42' },
        }),
      );
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toContain('retry after 42 seconds');
        // No structured retryAfterSeconds field by design — surface raw via cause.
        expect((ce.cause as { retryAfter: string }).retryAfter).toBe('42');
      }
    });
  });

  describe('Passthrough merge (4-arg form)', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('merges passthrough.query into the request URL', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { query: { custom: 'value', overview: 'simplified' } },
      });

      const q = queryOf();
      expect(q.get('custom')).toBe('value');
      // Passthrough query keys override connector defaults.
      expect(q.get('overview')).toBe('simplified');
    });

    it('merges passthrough.headers into request headers', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { headers: { 'X-Trace': 'abc' } },
      });

      const init = initOf();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['X-Trace']).toBe('abc');
    });
  });

  // Success-path malformed body: a 200 OK whose JSON fails to parse yields null
  // via `.catch(() => null)` and must surface a typed ConnectorError rather than
  // an uncaught SyntaxError.
  describe('malformed 200 body', () => {
    let connector: OsrmRoutingConnector;
    beforeEach(() => {
      connector = new OsrmRoutingConnector(defaultConfig);
    });

    it('throws ConnectorError on a non-JSON 200 body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

      let thrown: ConnectorError | null = null;
      try {
        await connector.route({ waypoints: TWO_WAYPOINTS });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown?.providerCode).toBe('unknown');
      expect(thrown?.message).toBe('OSRM routing returned a malformed response body');
    });
  });
});
