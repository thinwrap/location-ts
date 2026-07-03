import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OsrmMatrixConnector } from './osrm.matrix.connector';
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

function buildTableResponse(
  overrides: Partial<{
    code: string;
    durations: (number | null)[][];
    distances: (number | null)[][];
  }> = {},
  init?: ResponseInit,
): Response {
  return new Response(
    JSON.stringify({
      code: overrides.code ?? 'Ok',
      durations: overrides.durations ?? [
        [0, 100, 200],
        [100, 0, 150],
      ],
      distances: overrides.distances ?? [
        [0, 1000, 2000],
        [1000, 0, 1500],
      ],
    }),
    { status: 200, ...init },
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

const TWO_ORIGINS = [
  { lat: 38.8977, lng: -77.0365 },
  { lat: 38.8884, lng: -77.0199 },
];

const THREE_DESTS = [
  { lat: 38.8951, lng: -77.0364 },
  { lat: 38.9072, lng: -77.0369 },
  { lat: 38.8899, lng: -77.0091 },
];

describe('OsrmMatrixConnector', () => {
  describe('Constructor — baseUrl validation', () => {
    it('exposes providerId "osrm"', () => {
      const connector = new OsrmMatrixConnector(defaultConfig);
      expect(connector.providerId).toBe('osrm');
    });

    it('throws ConnectorError when baseUrl is missing', () => {
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new OsrmMatrixConnector({} as any),
      ).toThrow(ConnectorError);
    });

    it('throws ConnectorError when baseUrl is empty string', () => {
      expect(() => new OsrmMatrixConnector({ baseUrl: '' })).toThrow(
        ConnectorError,
      );
    });

    it('throws ConnectorError when config is null', () => {
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new OsrmMatrixConnector(null as any),
      ).toThrow(ConnectorError);
    });

    it('sets providerCode invalid_request + statusCode null on baseUrl throw', () => {
      try {
        new OsrmMatrixConnector({ baseUrl: '' });
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
      expect(() => new OsrmMatrixConnector({ baseUrl: '' })).toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Pre-flight validation — statusCode null, no HTTP call', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it('throws unsupported_field for departureTime', async () => {
      try {
        await connector.matrix({
          origins: TWO_ORIGINS,
          destinations: THREE_DESTS,
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
        await connector.matrix({
          origins: TWO_ORIGINS,
          destinations: THREE_DESTS,
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

    it('checks departureTime first when both pre-flight violations present', async () => {
      try {
        await connector.matrix({
          origins: TWO_ORIGINS,
          destinations: THREE_DESTS,
          departureTime: new Date('2024-06-15T08:00:00Z'),
          avoidTolls: true,
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unsupported_field');
      }
    });

    it('does NOT throw for avoidTolls=false (falsy)', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());
      await expect(
        connector.matrix({
          origins: TWO_ORIGINS,
          destinations: THREE_DESTS,
          avoidTolls: false,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('HTTP call shape', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it('GETs /table/v1/driving with lng,lat;lng,lat coordinates and zero-indexed sources/destinations', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());

      await connector.matrix({
        origins: TWO_ORIGINS,
        destinations: THREE_DESTS,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = urlOf();
      expect(url).toContain(
        'http://localhost:5000/table/v1/driving/-77.0365,38.8977;-77.0199,38.8884;-77.0364,38.8951;-77.0369,38.9072;-77.0091,38.8899',
      );
      expect(initOf().method).toBe('GET');

      const q = queryOf();
      expect(q.get('sources')).toBe('0;1');
      expect(q.get('destinations')).toBe('2;3;4');
      expect(q.get('annotations')).toBe('duration,distance');
    });

    it('zero-indexes sources/destinations against the combined coords list (asymmetric)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildTableResponse({
          durations: [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
          distances: [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        }),
      );

      await connector.matrix({
        origins: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        destinations: [
          { lat: 3, lng: 3 },
          { lat: 4, lng: 4 },
        ],
      });

      const q = queryOf();
      expect(q.get('sources')).toBe('0;1;2');
      expect(q.get('destinations')).toBe('3;4');
    });

    it.each<['driving' | 'walking' | 'cycling', string]>([
      ['driving', '/table/v1/driving/'],
      ['walking', '/table/v1/walking/'],
      ['cycling', '/table/v1/cycling/'],
    ])(
      'maps travelMode %s to profile path %s',
      async (input, expected) => {
        mockFetch.mockResolvedValueOnce(buildTableResponse());
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
          travelMode: input,
        });
        expect(urlOf()).toContain(expected);
      },
    );

    it('defaults to driving when travelMode is omitted', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      });
      expect(urlOf()).toContain('/table/v1/driving/');
    });

    it('does not include any Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());

      await connector.matrix({
        origins: TWO_ORIGINS,
        destinations: THREE_DESTS,
      });

      const init = initOf();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    });
  });

  describe('Annotations invariant', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it('forces annotations=duration,distance even when consumer attempts to override', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        _passthrough: { query: { annotations: 'duration' } },
      });
      const q = queryOf();
      expect(q.get('annotations')).toBe('duration,distance');
    });

    it('still applies other _passthrough.query params alongside the annotations invariant', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        _passthrough: {
          query: { fallback_speed: '60', annotations: 'duration' },
        },
      });
      const q = queryOf();
      expect(q.get('annotations')).toBe('duration,distance');
      expect(q.get('fallback_speed')).toBe('60');
    });

    it('merges _passthrough.headers onto the request', async () => {
      mockFetch.mockResolvedValueOnce(buildTableResponse());
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        _passthrough: { headers: { 'X-Trace': 'abc' } },
      });
      const init = initOf();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['X-Trace']).toBe('abc');
    });
  });

  describe('Result-shape normalization', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it('flattens 2D durations/distances into cells with correct indices (origin-major)', async () => {
      mockFetch.mockResolvedValueOnce(
        buildTableResponse({
          durations: [
            [10, 20, 30],
            [40, 50, 60],
          ],
          distances: [
            [100, 200, 300],
            [400, 500, 600],
          ],
        }),
      );

      const result = await connector.matrix({
        origins: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        destinations: [
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
          { lat: 4, lng: 4 },
        ],
      });

      expect(result.cells).toHaveLength(6);
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: 100,
        durationSeconds: 10,
      });
      expect(result.cells[2]).toEqual({
        originIndex: 0,
        destinationIndex: 2,
        distanceMeters: 300,
        durationSeconds: 30,
      });
      expect(result.cells[5]).toEqual({
        originIndex: 1,
        destinationIndex: 2,
        distanceMeters: 600,
        durationSeconds: 60,
      });
    });

    it('exposes the full vendor body on result.raw', async () => {
      const body = {
        code: 'Ok',
        durations: [[0, 1]],
        distances: [[0, 10]],
        sources: [{ name: 'A' }],
        destinations: [{ name: 'B' }, { name: 'C' }],
      };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });

      expect(result.raw).toEqual(body);
    });

    it('coerces null cells in vendor body to 0 meters / 0 seconds', async () => {
      mockFetch.mockResolvedValueOnce(
        buildTableResponse({
          durations: [[null, 120]],
          distances: [[null, 2000]],
        }),
      );
      const result = await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });
      expect(result.cells[0]).toEqual({
        originIndex: 0,
        destinationIndex: 0,
        distanceMeters: 0,
        durationSeconds: 0,
      });
      expect(result.cells[1]).toEqual({
        originIndex: 0,
        destinationIndex: 1,
        distanceMeters: 2000,
        durationSeconds: 120,
      });
    });
  });

  describe('In-body OSRM status codes', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    function buildInBodyError(code: string, message = '') {
      return new Response(
        JSON.stringify({
          code,
          message,
          durations: [],
          distances: [],
        }),
        { status: 200 },
      );
    }

    it('maps NoTable → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('NoTable', 'no table'));
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.providerMessage).toBe('no table');
      }
    });

    it('maps InvalidQuery → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('InvalidQuery'));
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('maps InvalidOptions → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(buildInBodyError('InvalidOptions'));
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
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
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('unknown');
      }
    });
  });

  describe('HTTP error mapping', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it.each<[number, string]>([
      [400, 'invalid_request'],
      [404, 'invalid_request'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
      [418, 'unknown'],
    ])(
      'HTTP %i maps to providerCode %s',
      async (status, expectedCode) => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'err' }), { status }),
        );
        await expect(
          connector.matrix({
            origins: [{ lat: 0, lng: 0 }],
            destinations: [{ lat: 1, lng: 1 }],
          }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: expectedCode,
          statusCode: status,
        });
      },
    );

    it('surfaces reverse-proxy 401 as auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 401 }),
      );
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
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
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toContain('retry after 42 seconds');
        // No structured retryAfterSeconds field by design — surface raw via cause.
        expect((ce.cause as { retryAfter: string }).retryAfter).toBe('42');
        expect(
          (ce as unknown as Record<string, unknown>).retryAfterSeconds,
        ).toBeUndefined();
      }
    });

    it('attaches retryAfter to cause even when error body is null', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '20' } }),
      );
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
        expect.fail('expected throw');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('rate_limited');
        expect(ce.providerMessage).toBe('retry after 20 seconds');
        expect((ce.cause as { retryAfter?: string })?.retryAfter).toBe('20');
      }
    });
  });

  // LOC-CP-1 (loc-CR #79/#99) — sparse/asymmetric/short table dimension guard
  describe('matrix dimension guard (LOC-CP-1)', () => {
    let connector: OsrmMatrixConnector;
    beforeEach(() => {
      connector = new OsrmMatrixConnector(defaultConfig);
    });

    it('throws ConnectorError when a row is shorter than the destination count', async () => {
      // 2 origins × 3 destinations, but row 1 has only 2 cols. Pre-fix this
      // silently zero-filled cell [1][2]; now it must throw.
      mockFetch.mockResolvedValueOnce(
        buildTableResponse({
          durations: [
            [0, 100, 200],
            [100, 0],
          ],
          distances: [
            [0, 1000, 2000],
            [1000, 0],
          ],
        }),
      );

      let caught: ConnectorError | null = null;
      try {
        await connector.matrix({ origins: TWO_ORIGINS, destinations: THREE_DESTS });
      } catch (err) {
        caught = err as ConnectorError;
      }

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('unknown');
      expect(caught?.providerMessage).toContain('2×3');
      expect(caught?.statusCode).toBeNull();
    });

    it('throws ConnectorError when the table has fewer rows than origins', async () => {
      mockFetch.mockResolvedValueOnce(
        buildTableResponse({
          durations: [[0, 100, 200]],
          distances: [[0, 1000, 2000]],
        }),
      );

      await expect(
        connector.matrix({ origins: TWO_ORIGINS, destinations: THREE_DESTS }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'unknown',
      });
    });

    it('preserves the raw vendor body on cause', async () => {
      const body = { code: 'Ok', durations: [[0]], distances: [[0]] };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      let caught: ConnectorError | null = null;
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
        });
      } catch (err) {
        caught = err as ConnectorError;
      }
      expect(caught?.cause).toEqual(body);
    });
  });
});
