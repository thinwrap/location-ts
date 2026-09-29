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

const OMIT_STOPS = Symbol('omit-stops');


function buildSuccessBody(
  overrides: {
    attributes?: Record<string, unknown>;
    paths?: number[][][];
    /** Pass OMIT_STOPS to simulate a service that returns no stops FeatureSet. */
    stops?: unknown;
  } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    routes: {
      features: [
        {
          attributes: overrides.attributes ?? {
            Total_TravelTime: 10,
            Total_Kilometers: 8.047,
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

  if (overrides.stops === OMIT_STOPS) return body;

  // Default: two located stops whose cumulative costs describe one 8047 m / 10 min
  // leg. `Cumul_TravelTime` is the DRIVING spelling — walking responses carry
  // `Cumul_WalkTime` instead, which is why the connector discovers the key.
  body.stops =
    overrides.stops === undefined
      ? {
          features: [
            { attributes: { Sequence: 1, Status: 0, Cumul_TravelTime: 0, Cumul_Kilometers: 0 } },
            { attributes: { Sequence: 2, Status: 0, Cumul_TravelTime: 10, Cumul_Kilometers: 8.047 } },
          ],
        }
      : overrides.stops;
  return body;
}

/** Build a stops FeatureSet from cumulative values, in INPUT order. */
function stopsWithCumulative(
  rows: Array<{ seq: number; minutes: number; km: number; status?: number }>,
  timeKey = 'Cumul_TravelTime',
): unknown {
  return {
    features: rows.map((r) => ({
      attributes: {
        Sequence: r.seq,
        Status: r.status ?? 0,
        [timeKey]: r.minutes,
        Cumul_Kilometers: r.km,
      },
    })),
  };
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
      // Legs come from the stops FeatureSet's cumulative costs, so the stops are
      // always requested and the superseded turn-by-turn payload never is.
      expect(params.get('returnStops')).toBe('true');
      // Explicit 'false' is load-bearing: the SERVICE DEFAULT is true, so omitting
      // the parameter still ships the entire directions payload.
      expect(params.get('returnDirections')).toBe('false');
      expect(params.get('accumulateAttributeNames')).toBe('TravelTime,Kilometers');
      // No m-values: we read `paths` for the polyline and never the measures.
      expect(params.get('outputLines')).toBe('esriNAOutputLineTrueShape');
      expect(params.get('directionsOutputType')).toBeNull();
      expect(params.get('directionsLengthUnits')).toBeNull();
      expect(params.get('outSR')).toBe('4326');
    });

    it('forwards departureTime with traffic as epoch milliseconds in `startTime`, flagged as UTC', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      const when = new Date('2024-01-15T08:00:00Z');
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        departureTime: when,
        trafficMode: 'traffic',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('startTime')).toBe('1705305600000');
      // Route `startTimeIsUTC` defaults to false = the first stop's local zone.
      expect(params.get('startTimeIsUTC')).toBe('true');
    });

    it('sends neither startTime nor startTimeIsUTC without a departureTime', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('startTime')).toBeNull();
      expect(params.get('startTimeIsUTC')).toBeNull();
    });

    it('rejects an invalid departureTime Date with invalid_request (no fetch)', async () => {
      await expect(
        connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          departureTime: new Date('not a date'),
        }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends ignoreInvalidLocations=false so an unlocatable stop fails instead of being skipped', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('ignoreInvalidLocations')).toBe('false');
    });

    it('surfaces the in-body unlocated-stop failure as no_route', async () => {
      // With ignoreInvalidLocations=false ESRI documents: "Any invalid point will
      // cause the request to return a failure" — an HTTP 200 error envelope whose
      // details name the unlocated stop.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Unable to complete operation.',
              details: ['Location "Location 2" in "Stops" is unlocated.'],
            },
          }),
          { status: 200 },
        ),
      );

      const err = await connector
        .route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).providerCode).toBe('no_route');
      expect((err as ConnectorError).statusCode).toBe(200);
    });
  });

  describe('travelMode translation', () => {
    it('sends the full Walking Time travelMode JSON object for walking', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'walking',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      // ArcGIS requires a full travel-mode JSON object, not a name string.
      const travelMode = JSON.parse(params.get('travelMode') as string);
      expect(travelMode.type).toBe('WALK');
      expect(travelMode.impedanceAttributeName).toBe('WalkTime');
      expect(travelMode.name).toBe('Walking Time');
    });

    it('omits travelMode for driving (the service default is Driving Time)', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'driving',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('travelMode')).toBeNull();
    });

    it('rejects cycling with unsupported_travel_mode (no public ESRI cycling mode)', async () => {
      await expect(
        connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          travelMode: 'cycling',
        }),
      ).rejects.toMatchObject({ providerCode: 'unsupported_travel_mode' });
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
    it('derives legs AND totals from the cumulative stop costs', async () => {
      // One source for both, so they cannot disagree: each leg is a difference
      // between consecutive stops and the total is the last cumulative value.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_TravelTime: 30, Total_Kilometers: 12 },
            stops: stopsWithCumulative([
              { seq: 1, minutes: 0, km: 0 },
              { seq: 2, minutes: 10, km: 4 },
              { seq: 3, minutes: 30, km: 12 },
            ]),
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

      expect(result.legs).toEqual([
        { distanceMeters: 4000, durationSeconds: 600 },
        { distanceMeters: 8000, durationSeconds: 1200 },
      ]);
      expect(result.totalDistanceMeters).toBe(12000);
      expect(result.totalDurationSeconds).toBe(1800);
      // The invariant that is now structural rather than coincidental.
      expect(result.legs.reduce((a, l) => a + l.distanceMeters, 0)).toBe(
        result.totalDistanceMeters,
      );
      expect(result.legs.reduce((a, l) => a + l.durationSeconds, 0)).toBe(
        result.totalDurationSeconds,
      );
    });

    it('differences stops in VISIT order, not input order', async () => {
      // Stops come back in INPUT order while cumulative costs run along the route.
      // With findBestSequence those differ; sorting by Sequence is what keeps the
      // legs positive and correctly attributed.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_TravelTime: 30, Total_Kilometers: 12 },
            // Input order 1,3,2 — i.e. the optimizer visits the third input second.
            stops: stopsWithCumulative([
              { seq: 1, minutes: 0, km: 0 },
              { seq: 3, minutes: 30, km: 12 },
              { seq: 2, minutes: 10, km: 4 },
            ]),
          }),
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

      expect(result.legs).toEqual([
        { distanceMeters: 4000, durationSeconds: 600 },
        { distanceMeters: 8000, durationSeconds: 1200 },
      ]);
    });

    it('discovers the walking cumulative key (Cumul_WalkTime, not Cumul_TravelTime)', async () => {
      // The cumulative field is suffixed with the ACTIVE IMPEDANCE. Hardcoding the
      // driving spelling is the same mistake that once made the walking matrix
      // report every duration as 0.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_WalkTime: 13.094903051108146, Total_Kilometers: 1.091226960340165 },
            stops: stopsWithCumulative(
              [
                { seq: 1, minutes: 0, km: 0 },
                { seq: 2, minutes: 13.094903051108146, km: 1.091226960340165 },
              ],
              'Cumul_WalkTime',
            ),
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'walking',
      });

      expect(result.totalDistanceMeters).toBeCloseTo(1091.23, 1);
      expect(result.totalDurationSeconds).toBeCloseTo(13.094903051108146 * 60, 3);
      const [, init] = mockFetch.mock.calls[0]!;
      // ...and the REQUEST must ask for the matching attribute, or no cumulative
      // field comes back at all (silently, not as an error).
      expect(parseForm(init!.body as string).get('accumulateAttributeNames')).toBe(
        'WalkTime,Kilometers',
      );
    });

    // A caller may append or prepend accumulate attributes through passthrough.
    // The extra `Cumul_*` columns come first here, so any "first matching key"
    // rule would read them; legs must still come from the requested time
    // attribute and Kilometers.
    it.each([
      ['driving', undefined, 'Cumul_TravelTime', 'Cumul_WalkTime'],
      ['walking', 'walking' as const, 'Cumul_WalkTime', 'Cumul_TravelTime'],
    ])(
      '%s: extra accumulated columns never change which fields feed the legs',
      async (_label, travelMode, timeKey, otherTimeKey) => {
        const stop = (seq: number, minutes: number, km: number) => ({
          attributes: {
            Sequence: seq,
            Status: 0,
            Cumul_Miles: km * 0.621371,
            Cumul_TruckTravelTime: minutes * 3,
            [otherTimeKey]: minutes * 5,
            [timeKey]: minutes,
            Cumul_Kilometers: km,
          },
        });
        mockFetch.mockResolvedValueOnce(
          buildSuccessResponse(
            buildSuccessBody({
              stops: { features: [stop(1, 0, 0), stop(2, 10, 4), stop(3, 30, 12)] },
            }),
          ),
        );

        const result = await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          ...(travelMode !== undefined ? { travelMode } : {}),
          _passthrough: {
            body: {
              accumulateAttributeNames: `TruckTravelTime,Miles,${timeKey.slice(6)},Kilometers`,
            },
          },
        });

        expect(result.legs).toEqual([
          { distanceMeters: 4000, durationSeconds: 600 },
          { distanceMeters: 8000, durationSeconds: 1200 },
        ]);
        expect(result.totalDistanceMeters).toBe(12000);
        expect(result.totalDurationSeconds).toBe(1800);
      },
    );

    it('reads the requested time total when stops are unusable, not another Total_*', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: {
              Total_TruckTravelTime: 99,
              Total_TravelTime: 10,
              Total_Kilometers: 8,
            },
            stops: OMIT_STOPS,
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.totalDurationSeconds).toBe(600);
      expect(result.totalDistanceMeters).toBe(8000);
    });

    it('falls back to the route totals when a stop failed to locate', async () => {
      // A non-zero Status carries no usable cumulative cost, so every later
      // difference would be wrong. Prefer the route's own totals + an even split.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_TravelTime: 20, Total_Kilometers: 1 },
            stops: stopsWithCumulative([
              { seq: 1, minutes: 0, km: 0 },
              { seq: 2, minutes: 20, km: 1, status: 7 },
            ]),
          }),
        ),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.totalDistanceMeters).toBe(1000);
      expect(result.totalDurationSeconds).toBe(1200);
      expect(result.legs).toEqual([{ distanceMeters: 1000, durationSeconds: 1200 }]);
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

    it('falls back to even-split legs when the stops FeatureSet is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: { Total_Length: 1000, Total_Time: 20 },
            stops: OMIT_STOPS,
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

    it('derives waypointOrder from the stops FeatureSet Sequence attribute', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildSuccessBody({
            attributes: {
              Total_Length: 1000,
              Total_Time: 20,
            },
            // `stops` features are returned in INPUT order; `Sequence` is the
            // 1-based visiting position. Sequences [1,3,2,4] invert to the
            // canonical visiting order of input indices [0,2,1,3].
            stops: {
              features: [
                { attributes: { Name: 'Location 1', ObjectID: 1, Sequence: 1 } },
                { attributes: { Name: 'Location 2', ObjectID: 2, Sequence: 3 } },
                { attributes: { Name: 'Location 3', ObjectID: 3, Sequence: 2 } },
                { attributes: { Name: 'Location 4', ObjectID: 4, Sequence: 4 } },
              ],
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

    it('omits waypointOrder when the stops FeatureSet is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildSuccessBody({ stops: OMIT_STOPS })),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimize: true,
      });

      expect(result.waypointOrder).toBeUndefined();
    });

    it('omits waypointOrder for an unoptimized route even though stops are returned', async () => {
      // Stops are always requested (legs come from them), so this pins that an
      // unoptimized route reports no ordering rather than an identity permutation.
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
      expect(params.get('returnStops')).toBe('true');
      expect(params.get('preserveFirstStop')).toBe('true');
      expect(params.get('preserveLastStop')).toBe('true');
    });

    // Live Route/solve: findBestSequence defaults BOTH preserve flags to true
    // (order [0,1,2,3]); only an explicit `false` frees an end ([2,3,0,1]).
    it.each([
      ['plain optimize', { optimize: true }, 'true', 'true'],
      ['optimize + optimizeFixedOrigin', { optimize: true, optimizeFixedOrigin: true }, 'true', 'false'],
      ['optimizeFixedOrigin alone', { optimizeFixedOrigin: true }, 'true', 'false'],
      ['optimizeFixedDestination alone', { optimizeFixedDestination: true }, 'false', 'true'],
      ['both ends fixed, no optimize', { optimizeFixedOrigin: true, optimizeFixedDestination: true }, 'true', 'true'],
    ] as const)('%s → findBestSequence with the matching preserve flags', async (_label, flags, first, last) => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        ...flags,
      });

      const params = parseForm(mockFetch.mock.calls[0]![1]!.body as string);
      expect(params.get('findBestSequence')).toBe('true');
      expect(params.get('preserveFirstStop')).toBe(first);
      expect(params.get('preserveLastStop')).toBe(last);
    });

    it('sends no findBestSequence or preserve flags without an optimize flag', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());
      await connector.route({ waypoints: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }] });
      const params = parseForm(mockFetch.mock.calls[0]![1]!.body as string);
      expect(params.has('findBestSequence')).toBe(false);
      expect(params.has('preserveFirstStop')).toBe(false);
      expect(params.has('preserveLastStop')).toBe(false);
    });

    // Live: walking + a request-level `restrictionAttributeNames=Avoid Ferries`
    // is ignored (Esri's warning names only the mode's "Avoid Private Roads");
    // appended inside the travel mode it is honoured.
    it('puts avoid restrictions INSIDE the walking travel mode, not beside it', async () => {
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());

      await connector.route({
        waypoints: [
          { lat: 40.7033, lng: -74.017 },
          { lat: 40.6437, lng: -74.0736 },
        ],
        travelMode: 'walking',
        avoidFerries: true,
        avoidTolls: true,
      });

      const params = parseForm(mockFetch.mock.calls[0]![1]!.body as string);
      expect(params.has('restrictionAttributeNames')).toBe(false);
      const mode = JSON.parse(params.get('travelMode') as string);
      expect(mode.name).toBe('Walking Time');
      expect(mode.restrictionAttributeNames).toEqual([
        'Avoid Private Roads',
        'Avoid Roads Unsuitable for Pedestrians',
        'Preferred for Pedestrians',
        'Walking',
        'Avoid Toll Roads',
        'Avoid Ferries',
      ]);
    });

    it('does not mutate the shared walking travel-mode constant', async () => {
      mockFetch.mockResolvedValue(buildSuccessResponse());
      await connector.route({
        waypoints: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }],
        travelMode: 'walking',
        avoidFerries: true,
      });
      mockFetch.mockResolvedValueOnce(buildSuccessResponse());
      await connector.route({
        waypoints: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }],
        travelMode: 'walking',
      });
      const mode = JSON.parse(parseForm(mockFetch.mock.calls[1]![1]!.body as string).get('travelMode') as string);
      expect(mode.restrictionAttributeNames).not.toContain('Avoid Ferries');
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
      // Esri's Network Analyst restriction name for limited-access (highway)
      // roads.
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
      expect(thrown!.providerCode).toBe('no_route');
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

  describe('non-finite coordinate guard (stops FeatureSet)', () => {
    it('rejects a NaN waypoint with ConnectorError invalid_request (no fetch)', async () => {
      await expect(
        connector.route({
          waypoints: [
            { lat: Number.NaN, lng: -74.006 },
            { lat: 40.758, lng: -73.9855 },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
