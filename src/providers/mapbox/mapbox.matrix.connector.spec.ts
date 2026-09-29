import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapboxMatrixConnector } from './mapbox.matrix.connector';
import type { MapboxConfig } from './mapbox.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: MapboxConfig = { accessToken: 'pk.test123' };

function buildMatrixResponse(
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
        [0, 120],
        [130, 0],
      ],
      distances: overrides.distances ?? [
        [0, 2000],
        [2100, 0],
      ],
    }),
    { status: 200, ...init },
  );
}

function parseUrlParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.substring(q + 1) : '');
}

describe('MapboxMatrixConnector', () => {
  let connector: MapboxMatrixConnector;

  beforeEach(() => {
    connector = new MapboxMatrixConnector(defaultConfig);
  });

  it('should have providerId "mapbox"', () => {
    expect(connector.providerId).toBe('mapbox');
  });

  // HTTP call shape: URL, method, query params
  it('should GET Matrix v1 with correct URL, profile, and query', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());

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

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(init?.method).toBe('GET');
    expect(url).toContain(
      'https://api.mapbox.com/directions-matrix/v1/mapbox/driving/',
    );
    // Combined coords list (origins + destinations, lng,lat;lng,lat;...)
    expect(url).toContain(
      '-74.006,40.7128;-73.9855,40.758;-73.9856,40.7484;-73.9776,40.7614',
    );
    const params = parseUrlParams(url as string);
    expect(params.get('access_token')).toBe('pk.test123');
    expect(params.get('sources')).toBe('0;1');
    expect(params.get('destinations')).toBe('2;3');
    expect(params.get('annotations')).toBe('duration,distance');

    expect(result.cells).toHaveLength(4);
  });

  // Sources/destinations indexing for asymmetric inputs
  it('should zero-index sources/destinations against the combined coords list', async () => {
    mockFetch.mockResolvedValueOnce(
      buildMatrixResponse({
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

    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.get('sources')).toBe('0;1;2');
    expect(params.get('destinations')).toBe('3;4');
  });

  // travelMode → profile mapping
  it.each<['driving' | 'walking' | 'cycling', string]>([
    ['driving', '/mapbox/driving/'],
    ['walking', '/mapbox/walking/'],
    ['cycling', '/mapbox/cycling/'],
  ])('should map travelMode %s to profile path %s', async (input, expected) => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: input,
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain(expected);
  });

  it('should default to driving when travelMode is omitted', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/mapbox/driving/');
  });

  // Live: directions-matrix/v1/mapbox/driving-traffic/… → 200, different durations.
  it('should select the driving-traffic profile for trafficMode live', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 40.8509, lng: -73.9701 }],
      destinations: [{ lat: 40.8448, lng: -73.8648 }],
      trafficMode: 'live',
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(new URL(url as string).pathname).toMatch(
      /^\/directions-matrix\/v1\/mapbox\/driving-traffic\//,
    );
  });

  it.each<['walking' | 'cycling', string]>([
    ['walking', '/mapbox/walking/'],
    ['cycling', '/mapbox/cycling/'],
  ])('should keep the %s profile under trafficMode live', async (travelMode, expected) => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode,
      trafficMode: 'live',
    });
    expect(mockFetch.mock.calls[0]![0] as string).toContain(expected);
  });

  // Live: Matrix with `exclude=toll` or `depart_at` → 422 "Request too large
  // for custom parameters" (exclude is undocumented, depart_at a sign-up beta).
  it('should reject avoidTolls with unsupported_option before any request', async () => {
    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        avoidTolls: true,
      }),
    ).rejects.toMatchObject({ providerCode: 'unsupported_option', statusCode: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reject departureTime with traffic as unsupported_field before any request', async () => {
    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        departureTime: new Date('2026-09-29T13:00:00Z'),
        trafficMode: 'traffic',
      }),
    ).rejects.toMatchObject({ providerCode: 'unsupported_field', statusCode: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should still let a beta account send depart_at through passthrough', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: { query: { depart_at: '2026-09-29T13:00:00Z' } },
    });
    const [url] = mockFetch.mock.calls[0]!;
    expect(parseUrlParams(url as string).get('depart_at')).toBe('2026-09-29T13:00:00Z');
  });

  // annotations is a default like any other: a caller's list replaces it.
  it('should let _passthrough.query.annotations replace the default list', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: { query: { annotations: 'distance,duration' } },
    });
    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.getAll('annotations')).toEqual(['distance,duration']);
  });

  it('should keep the default annotations when passthrough sets only other params', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: { query: { fallback_speed: '60' } },
    });
    const [url] = mockFetch.mock.calls[0]!;
    const params = parseUrlParams(url as string);
    expect(params.get('annotations')).toBe('duration,distance');
    expect(params.get('fallback_speed')).toBe('60');
  });

  it('should merge _passthrough.headers onto the request', async () => {
    mockFetch.mockResolvedValueOnce(buildMatrixResponse());
    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: { headers: { 'X-Custom': 'value' } },
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('value');
  });

  // 2D-to-flat-cells normalization
  it('should flatten 2D durations/distances into cells with correct indices', async () => {
    mockFetch.mockResolvedValueOnce(
      buildMatrixResponse({
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

  it('should expose the full vendor body on result.raw', async () => {
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

  it('omits unroutable (null) cells rather than coercing to 0', async () => {
    // Mapbox returns null for an unroutable pair; that cell must be omitted, not
    // reported as a 0m/0s cell (which reads as "same location").
    mockFetch.mockResolvedValueOnce(
      buildMatrixResponse({
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
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 1,
      distanceMeters: 2000,
      durationSeconds: 120,
    });
  });

  describe('mapVendorError mapping table', () => {
    it.each<[number, Record<string, unknown> | null, string]>([
      [401, null, 'auth_failed'],
      [403, null, 'auth_failed'],
      // A 422 is read by its body code, as on Mapbox routing.
      [422, { message: 'No route', code: 'NoRoute' }, 'no_route'],
      [422, { message: 'No segment', code: 'NoSegment' }, 'no_route'],
      [422, { message: 'bad coordinate', code: 'InvalidInput' }, 'invalid_request'],
      [422, { message: 'x' }, 'invalid_request'],
      [429, null, 'rate_limited'],
      [400, { message: 'bad request' }, 'invalid_request'],
      [500, null, 'provider_unavailable'],
      [503, null, 'provider_unavailable'],
      [418, null, 'unknown'],
    ])(
      'HTTP %i with body %j maps to providerCode %s',
      async (status, errorBody, expectedCode) => {
        mockFetch.mockResolvedValueOnce(
          new Response(errorBody === null ? '' : JSON.stringify(errorBody), { status }),
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
  });

  it('should throw ConnectorError when HTTP fails', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Too many coords' }), { status: 422 }),
    );
    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('should throw ConnectorError on 200-OK envelope with code !== "Ok"', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'NoRoute',
          durations: [],
          distances: [],
        }),
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
    // Matrix documents NoRoute on HTTP 200: a routing outcome, not a bad request.
    expect((thrown as ConnectorError).providerCode).toBe('no_route');
    expect((thrown as ConnectorError).statusCode).toBe(200);
  });

  it('maps a 200 InvalidInput envelope to invalid_request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'InvalidInput' }), { status: 200 }),
    );
    await expect(
      connector.matrix({ origins: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
  });

  // Retry-After surface (no structured retryAfterSeconds field per feedback memory)
  it('should surface Retry-After header in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: 'Rate limit exceeded' }),
        { status: 429, headers: { 'Retry-After': '45' } },
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
    expect(caught?.providerCode).toBe('rate_limited');
    expect(caught?.statusCode).toBe(429);
    expect(caught?.providerMessage).toBe('Rate limit exceeded; retry after 45 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('45');
    // No structured retryAfterSeconds field by design
    expect(
      (caught as unknown as Record<string, unknown>)?.retryAfterSeconds,
    ).toBeUndefined();
  });

  // A sparse/asymmetric/short matrix must never be read as a full grid.
  describe('matrix dimension guard', () => {
    it('throws ConnectorError when a row is shorter than the destination count', async () => {
      // 2 origins × 2 destinations requested, but the second row has only 1 col.
      // Reading cell [1][1] anyway would fabricate it, so the matrix is refused.
      mockFetch.mockResolvedValueOnce(
        buildMatrixResponse({
          durations: [
            [0, 120],
            [130],
          ],
          distances: [
            [0, 2000],
            [2100],
          ],
        }),
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

    it('throws ConnectorError when the matrix has fewer rows than origins', async () => {
      mockFetch.mockResolvedValueOnce(
        buildMatrixResponse({
          durations: [[0, 120]],
          distances: [[0, 2000]],
        }),
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

  it('should attach retryAfter to cause even when error body is null', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'Retry-After': '20' } }),
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

    expect(caught?.providerCode).toBe('rate_limited');
    expect(caught?.providerMessage).toBe('retry after 20 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('20');
  });
});
