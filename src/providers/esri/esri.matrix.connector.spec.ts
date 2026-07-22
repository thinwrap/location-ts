import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriMatrixConnector } from './esri.matrix.connector';
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

const MATRIX_URL =
  'https://route-api.arcgis.com/arcgis/rest/services/World/OriginDestinationCostMatrix/NAServer/OriginDestinationCostMatrix_World/solveODCostMatrix';

/**
 * Build a real sparse `odCostMatrix` payload (esriNAODOutputSparseMatrix).
 *
 * `rows` is keyed by 1-based origin OID; each maps a 1-based destination OID to
 * a cost-value array ordered per `costAttributeNames`
 * (`[TravelTime(minutes), Kilometers(km)]` by default).
 */
function buildOdCostMatrixBody(
  rows: Record<string, Record<string, number[]>>,
  costAttributeNames: string[] = ['TravelTime', 'Kilometers'],
): Record<string, unknown> {
  return {
    odCostMatrix: {
      costAttributeNames,
      ...rows,
    },
  };
}

function buildSuccessResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

describe('EsriMatrixConnector', () => {
  let connector: EsriMatrixConnector;

  beforeEach(() => {
    connector = new EsriMatrixConnector(defaultConfig);
  });

  it('exposes providerId "esri"', () => {
    expect(connector.providerId).toBe('esri');
  });

  describe('HTTP dispatch ', () => {
    it('POSTs form-encoded data to the solveODCostMatrix endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect((url as string).split('?')[0]).toBe(MATRIX_URL);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = parseForm(init!.body as string);
      expect(params.get('f')).toBe('json');
      expect(params.get('token')).toBe('esri-test-token');
      expect(params.get('outputType')).toBe('esriNAODOutputSparseMatrix');
      expect(params.get('outSR')).toBe('4326');
    });

    it('forwards departureTime as epoch milliseconds in `startTime`', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      const when = new Date('2026-05-17T08:00:00Z');
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        departureTime: when,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('startTime')).toBe(String(when.getTime()));
    });

    it('sends the full Walking Time travelMode JSON object for walking', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        travelMode: 'walking',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      const travelMode = JSON.parse(params.get('travelMode') as string);
      expect(travelMode.type).toBe('WALK');
      expect(travelMode.impedanceAttributeName).toBe('WalkTime');
    });

    it('rejects cycling with unsupported_travel_mode', async () => {
      await expect(
        connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
          travelMode: 'cycling',
        }),
      ).rejects.toMatchObject({ providerCode: 'unsupported_travel_mode' });
    });
  });

  describe('FeatureSet `origins`/`destinations` encoding ', () => {
    it('serializes origins as ESRI FeatureSet with WGS-84 spatialReference', async () => {
      // 2 origins × 1 destination — response must cover the full grid.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody({ '1': { '1': [5, 1] }, '2': { '1': [8, 4] } }),
        ),
      );

      await connector.matrix({
        origins: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
        ],
        destinations: [{ lat: 41.0, lng: -73.0 }],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      const originsJson = params.get('origins');
      expect(originsJson).not.toBeNull();
      const origins = JSON.parse(originsJson as string) as {
        features: Array<{
          geometry: { x: number; y: number; spatialReference: { wkid: number } };
        }>;
      };
      expect(origins.features).toHaveLength(2);
      expect(origins.features[0]).toEqual({
        geometry: {
          x: -74.006,
          y: 40.7128,
          spatialReference: { wkid: 4326 },
        },
      });
      expect(origins.features[1]!.geometry.x).toBe(-73.9855);
      expect(origins.features[1]!.geometry.y).toBe(40.758);
    });

    it('serializes destinations as ESRI FeatureSet with WGS-84 spatialReference', async () => {
      // 1 origin × 2 destinations — response must cover the full grid.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody({ '1': { '1': [5, 1], '2': [10, 5] } }),
        ),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [
          { lat: 40.7484, lng: -73.9856 },
          { lat: 40.7614, lng: -73.9776 },
        ],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      const destJson = params.get('destinations');
      expect(destJson).not.toBeNull();
      const dest = JSON.parse(destJson as string) as {
        features: Array<{
          geometry: { x: number; y: number; spatialReference: { wkid: number } };
        }>;
      };
      expect(dest.features).toHaveLength(2);
      expect(dest.features[0]).toEqual({
        geometry: {
          x: -73.9856,
          y: 40.7484,
          spatialReference: { wkid: 4326 },
        },
      });
    });
  });

  describe('Auth handling ', () => {
    it('forwards apiKey via the `token` form field', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('token')).toBe('esri-test-token');
    });

    it('forwards arcgisToken via the same `token` form field when set instead', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      const c = new EsriMatrixConnector({ arcgisToken: 'oauth-bearer' });
      await c.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('token')).toBe('oauth-bearer');
    });

    it('throws invalid_request when both apiKey and arcgisToken are set (XOR invariant)', async () => {
      const c = new EsriMatrixConnector({ apiKey: 'a', arcgisToken: 'b' });

      let thrown: unknown;
      try {
        await c.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws auth_failed when neither apiKey nor arcgisToken is set', async () => {
      const c = new EsriMatrixConnector({});

      let thrown: unknown;
      try {
        await c.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('auth_failed');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Result-shape normalization ', () => {
    // Live NYC → Bridgeport ground truth (route-api.arcgis.com World OD Cost
    // Matrix, verified 2026-07-20): TravelTime in minutes, Kilometers in km.
    const TIME1 = 93.25787017375364;
    const KM1 = 98.94833503121721;
    const TIME2 = 81.54786997057796;
    const KM2 = 99.08865887338234;

    it('flattens the sparse odCostMatrix object into cells with minute→second + km→meter conversion', async () => {
      // Real 2-origin × 1-destination sparse shape from the ground-truth doc.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody({
            '1': { '1': [TIME1, KM1] },
            '2': { '1': [TIME2, KM2] },
          }),
        ),
      );

      const result = await connector.matrix({
        origins: [
          { lat: 40.7484, lng: -73.9857 },
          { lat: 40.758, lng: -73.9855 },
        ],
        destinations: [{ lat: 41.1792, lng: -73.1952 }],
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: KM1 * 1000, // 98.94833503121721 km → 98948.33… m
        durationSeconds: TIME1 * 60, // 93.25787… min → 5595.47… s
      });
      expect(result.cells[1]).toEqual({
        originIndex: 1,
        destinationIndex: 0,
        distanceMeters: KM2 * 1000,
        durationSeconds: TIME2 * 60,
      });
    });

    it('honors costAttributeNames ordering when Kilometers precedes TravelTime', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody(
            { '1': { '1': [KM1, TIME1] } }, // [km, time] with reversed names
            ['Kilometers', 'TravelTime'],
          ),
        ),
      );

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      expect(result.cells).toHaveLength(1);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: KM1 * 1000,
        durationSeconds: TIME1 * 60,
      });
    });

    it('decodes the WalkTime impedance column for a walking matrix (real live shape)', async () => {
      // With a WALK travel mode, ArcGIS overrides the requested impedance, so
      // costAttributeNames comes back as ['WalkTime', 'Kilometers'] — NOT
      // 'TravelTime'. The pre-fix decoder looked up 'TravelTime' only and
      // silently reported every duration as 0. Live values from
      // route-api.arcgis.com (2026-07-21).
      const WALK_MIN = 13.094903051108146;
      const WALK_KM = 1.091226960340165;
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody(
            { '1': { '1': [WALK_MIN, WALK_KM] } },
            ['WalkTime', 'Kilometers'],
          ),
        ),
      );

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        travelMode: 'walking',
      });

      expect(result.cells).toHaveLength(1);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: WALK_KM * 1000,
        durationSeconds: WALK_MIN * 60,
      });
    });

    it('falls back to the odLines.features[] straight-lines shape', async () => {
      // Real straight-lines shape: OriginID/DestinationID + Total_TravelTime
      // (minutes) / Total_Kilometers (km). 1 origin × 2 destinations.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    ObjectID: 1,
                    OriginID: 1,
                    DestinationID: 1,
                    Total_TravelTime: TIME1,
                    Total_Kilometers: KM1,
                  },
                },
                {
                  attributes: {
                    ObjectID: 2,
                    OriginID: 1,
                    DestinationID: 2,
                    Total_TravelTime: TIME2,
                    Total_Kilometers: KM2,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: KM1 * 1000,
        durationSeconds: TIME1 * 60,
      });
      expect(result.cells[1]!.destinationIndex).toBe(1);
    });

    it('exposes the raw vendor body in result.raw', async () => {
      const body = buildOdCostMatrixBody({ '1': { '1': [5, 1] } });
      mockFetch.mockResolvedValueOnce(buildSuccessResponse(body));

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      expect(result.raw).toMatchObject({
        odCostMatrix: {
          costAttributeNames: ['TravelTime', 'Kilometers'],
          '1': { '1': [5, 1] },
        },
      });
    });

    it('emits restrictionAttributeNames for avoidTolls', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        avoidTolls: true,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('restrictionAttributeNames')).toContain(
        'Avoid Toll Roads',
      );
    });
  });

  describe('mapVendorError ', () => {
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
          new Response(JSON.stringify({ message: 'fail' }), {
            status: c.status,
          }),
        );
        let thrown: unknown;
        try {
          await connector.matrix({
            origins: [{ lat: 0, lng: 0 }],
            destinations: [{ lat: 1, lng: 1 }],
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConnectorError);
        expect((thrown as ConnectorError).statusCode).toBe(c.status);
        expect((thrown as ConnectorError).providerCode).toBe(c.expected);
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
          await connector.matrix({
            origins: [{ lat: 0, lng: 0 }],
            destinations: [{ lat: 1, lng: 1 }],
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
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
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
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
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
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerMessage).toContain('retry after 42 seconds');
      expect(thrown!.providerMessage).toContain('Too Many Requests');
      const cause = thrown!.cause as Record<string, unknown> | undefined;
      expect(cause?.retryAfter).toBe('42');
      // No structured retryAfterSeconds field per feedback memory.
      expect(
        (thrown as unknown as Record<string, unknown>).retryAfterSeconds,
      ).toBeUndefined();
    });
  });

  describe('200-with-error-body inspection ', () => {
    it('throws ConnectorError when HTTP 200 carries an error body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid token', code: 498 },
            odCostMatrix: { costAttributeNames: ['TravelTime', 'Kilometers'] },
          }),
          { status: 200 },
        ),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.statusCode).toBe(200);
      expect(thrown!.providerCode).toBe('auth_failed');
      expect(thrown!.providerMessage).toBe('Invalid token');
    });

    it('throws ConnectorError when HTTP 200 has neither odCostMatrix nor odLines', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('unknown');
      expect(thrown!.providerMessage).toBe(
        'ESRI Matrix response missing odCostMatrix and odLines payload',
      );
    });
  });

  describe('input validation', () => {
    it('throws invalid_request when origins is empty', async () => {
      let thrown: unknown;
      try {
        await connector.matrix({
          origins: [],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws invalid_request when destinations is empty', async () => {
      let thrown: unknown;
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [],
        });
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
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        _passthrough: { body: { impedanceAttributeName: 'TruckMinutes' } },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = parseForm(init!.body as string);
      expect(params.get('impedanceAttributeName')).toBe('TruckMinutes');
    });

    it('merges _passthrough.headers and _passthrough.query into the request', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody({ '1': { '1': [5, 1] } })),
      );

      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
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

  // Matrix sparse-cell omission + OID guards. A sparse matrix (unroutable pairs
  // omitted by Esri) is returned as-is with indexed cells — parity with the other
  // providers, superseding the earlier whole-grid throw (loc-CR #79/#99/#100).
  describe('matrix sparse-cell omission + OID guards', () => {
    it('omits a destination a sparse origin lacks (returns the indexed cells)', async () => {
      // 2×2 requested, but origin 2 only has dest 1 → three routable cells.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody({
            '1': { '1': [5, 1], '2': [10, 5] },
            '2': { '1': [8, 4] },
          }),
        ),
      );

      const result = await connector.matrix({
        origins: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        destinations: [
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
      });

      expect(result.cells.map((c) => [c.originIndex, c.destinationIndex])).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
      ]);
    });

    it('returns a sparse result when the matrix has fewer origins than requested', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody({ '1': { '1': [5, 1], '2': [10, 5] } }),
        ),
      );

      const result = await connector.matrix({
        origins: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        destinations: [
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
      });

      expect(result.cells.map((c) => [c.originIndex, c.destinationIndex])).toEqual([
        [0, 0],
        [0, 1],
      ]);
    });

    it('throws ConnectorError on an odLines OriginID of 0 (would produce a negative index)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    OriginID: 0,
                    DestinationID: 1,
                    Total_TravelTime: 5,
                    Total_Kilometers: 1,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      let caught: ConnectorError | null = null;
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        caught = err as ConnectorError;
      }

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('unknown');
      expect(caught?.providerMessage).toContain('OID');
    });

    it('omits unreachable pairs from an odLines FeatureSet (sparse coverage)', async () => {
      // 1×2 grid requested, but only one routable feature returned → one cell.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    OriginID: 1,
                    DestinationID: 1,
                    Total_TravelTime: 5,
                    Total_Kilometers: 1,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });
      expect(result.cells.map((c) => [c.originIndex, c.destinationIndex])).toEqual([[0, 0]]);
    });
  });

  describe('non-finite coordinate guard (point FeatureSet)', () => {
    it('rejects a NaN origin with ConnectorError invalid_request (no fetch)', async () => {
      await expect(
        connector.matrix({
          origins: [{ lat: Number.NaN, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a NaN destination with ConnectorError invalid_request (no fetch)', async () => {
      await expect(
        connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: Number.POSITIVE_INFINITY }],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
