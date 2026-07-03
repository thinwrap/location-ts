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
 * Build a modern `odCostMatrix.costMatrix.values` payload.
 *
 * Each cell is a `[Total_Time(minutes), Total_Distance(meters)]` tuple matching
 * the `costAttributeNames` order in.
 */
function buildOdCostMatrixBody(
  values: Array<Array<number | [number, number]>>,
  costAttributeNames: string[] = ['Total_Time', 'Total_Distance'],
): Record<string, unknown> {
  return {
    odCostMatrix: {
      costAttributeNames,
      costMatrix: { values },
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
  });

  describe('FeatureSet `origins`/`destinations` encoding ', () => {
    it('serializes origins as ESRI FeatureSet with WGS-84 spatialReference', async () => {
      // 2 origins × 1 destination — response must cover the full grid.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]], [[8, 4000]]])),
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000], [10, 5000]]])),
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
    it('flattens odCostMatrix.costMatrix.values 2-D array into cells with minute→second conversion', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody([
            [
              [5, 1000],
              [10, 5000],
            ],
            [
              [8, 4000],
              [3, 1500],
            ],
          ]),
        ),
      );

      const result = await connector.matrix({
        origins: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
        ],
        destinations: [
          { lat: 40.7484, lng: -73.9856 },
          { lat: 40.7614, lng: -73.9776 },
        ],
      });

      expect(result.cells).toHaveLength(4);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: 1000,
        durationSeconds: 300, // 5 min * 60
      });
      expect(result.cells[1]).toEqual({
        originIndex: 0,
        destinationIndex: 1,
        distanceMeters: 5000,
        durationSeconds: 600,
      });
      expect(result.cells[3]).toEqual({
        originIndex: 1,
        destinationIndex: 1,
        distanceMeters: 1500,
        durationSeconds: 180,
      });
    });

    it('honors costAttributeNames ordering when Total_Distance precedes Total_Time', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody(
            [[[1000, 5]]], // [distance, time] with reversed names
            ['Total_Distance', 'Total_Time'],
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
        distanceMeters: 1000,
        durationSeconds: 300,
      });
    });

    it('falls back to legacy odLines.features[] shape for brownfield parity', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    OriginOID: 1,
                    DestinationOID: 1,
                    Total_Time: 5,
                    Total_Distance: 1000,
                  },
                },
                {
                  attributes: {
                    OriginOID: 1,
                    DestinationOID: 2,
                    Total_Time: 10,
                    Total_Distance: 5000,
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
        distanceMeters: 1000,
        durationSeconds: 300,
      });
      expect(result.cells[1]!.destinationIndex).toBe(1);
    });

    it('exposes the raw vendor body in result.raw', async () => {
      const body = buildOdCostMatrixBody([[[5, 1000]]]);
      mockFetch.mockResolvedValueOnce(buildSuccessResponse(body));

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });

      expect(result.raw).toMatchObject({
        odCostMatrix: { costMatrix: { values: [[[5, 1000]]] } },
      });
    });

    it('emits restrictionAttributeNames for avoidTolls', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
            odCostMatrix: { costMatrix: { values: [] } },
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000]]])),
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

  // LOC-CP-1 (loc-CR #79/#99/#100/#101) — matrix dimension/coverage + OID guards
  describe('matrix dimension guard (LOC-CP-1)', () => {
    it('throws ConnectorError when a costMatrix row is shorter than the destination count', async () => {
      // 2×2 requested, but row 1 has only 1 col. Pre-fix this silently emitted
      // fewer cells with no signal; now it must throw.
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(
          buildOdCostMatrixBody([[[5, 1000], [10, 5000]], [[8, 4000]]]),
        ),
      );

      let caught: ConnectorError | null = null;
      try {
        await connector.matrix({
          origins: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          destinations: [
            { lat: 2, lng: 2 },
            { lat: 3, lng: 3 },
          ],
        });
      } catch (err) {
        caught = err as ConnectorError;
      }

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('unknown');
      expect(caught?.providerMessage).toContain('2×2');
    });

    it('throws ConnectorError when costMatrix has fewer rows than origins', async () => {
      mockFetch.mockResolvedValueOnce(
        buildSuccessResponse(buildOdCostMatrixBody([[[5, 1000], [10, 5000]]])),
      );

      await expect(
        connector.matrix({
          origins: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          destinations: [
            { lat: 2, lng: 2 },
            { lat: 3, lng: 3 },
          ],
        }),
      ).rejects.toMatchObject({ name: 'ConnectorError', providerCode: 'unknown' });
    });

    it('throws ConnectorError on a legacy odLines OID of 0 (would produce a negative index)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    OriginOID: 0,
                    DestinationOID: 1,
                    Total_Time: 5,
                    Total_Distance: 1000,
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

    it('throws ConnectorError when legacy odLines omits unreachable pairs (sparse coverage)', async () => {
      // 1×2 grid requested, but only one routable feature returned.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            odLines: {
              features: [
                {
                  attributes: {
                    OriginOID: 1,
                    DestinationOID: 1,
                    Total_Time: 5,
                    Total_Distance: 1000,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      await expect(
        connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
        }),
      ).rejects.toMatchObject({ name: 'ConnectorError', providerCode: 'unknown' });
    });
  });
});
