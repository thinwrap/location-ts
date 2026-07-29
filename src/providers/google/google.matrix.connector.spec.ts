import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleMatrixConnector } from './google.matrix.connector';
import type { GoogleConfig } from './google.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: GoogleConfig = { apiKey: 'test-api-key' };

/**
 * Helper: build a Google RouteMatrix v2 NDJSON response — one JSON object per
 * line, concatenated by newlines, NOT array-wrapped. Mirrors the real API
 * shape.
 */
function buildNdjsonResponse(
  elements: Array<Record<string, unknown>>,
  init?: ResponseInit,
): Response {
  const body = elements.map((el) => JSON.stringify(el)).join('\n');
  return new Response(body, { status: 200, ...init });
}

describe('GoogleMatrixConnector', () => {
  let connector: GoogleMatrixConnector;

  beforeEach(() => {
    connector = new GoogleMatrixConnector(defaultConfig);
  });

  it('should have providerId "google"', () => {
    expect(connector.providerId).toBe('google');
  });

  // Route Matrix bills PER ELEMENT, so the implicit Pro-SKU promotion cost
  // origins x destinations times more than the routing one. `departureTime` alone
  // no longer enables traffic.
  it('keeps routingPreference TRAFFIC_UNAWARE when only departureTime is provided', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 100, duration: '10s', condition: 'ROUTE_EXISTS' },
      ]),
    );

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      departureTime: new Date('2026-01-01T12:00:00Z'),
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.departureTime).toBe('2026-01-01T12:00:00.000Z');
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
  });

  it('sets routingPreference TRAFFIC_AWARE only when trafficMode is "live"', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 100, duration: '10s', condition: 'ROUTE_EXISTS' },
      ]),
    );

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      trafficMode: 'live',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
  });

  // travelMode mapping (driving → DRIVE | walking → WALK | cycling → BICYCLE)
  it.each<['driving' | 'walking' | 'cycling', string]>([
    ['driving', 'DRIVE'],
    ['walking', 'WALK'],
    ['cycling', 'BICYCLE'],
  ])('should map travelMode %s to %s', async (input, expected) => {
    mockFetch.mockResolvedValueOnce(buildNdjsonResponse([]));

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: input,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.travelMode).toBe(expected);
  });

  it('should include avoidTolls in routeModifiers', async () => {
    mockFetch.mockResolvedValueOnce(buildNdjsonResponse([]));

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      avoidTolls: true,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routeModifiers).toEqual({ avoidTolls: true });
  });

  // NDJSON parser: assert multi-line response parses to multiple cells
  it('should parse NDJSON multi-line response into multiple cells', async () => {
    const ndjsonBody =
      '{"originIndex":0,"destinationIndex":0,"distanceMeters":1000,"duration":"60s"}\n' +
      '{"originIndex":0,"destinationIndex":1,"distanceMeters":2000,"duration":"120s"}\n' +
      '{"originIndex":1,"destinationIndex":0,"distanceMeters":1500,"duration":"90s"}';

    mockFetch.mockResolvedValueOnce(new Response(ndjsonBody, { status: 200 }));

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

    expect(result.cells).toHaveLength(3);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      distanceMeters: 1000,
      durationSeconds: 60,
    });
    expect(result.cells[2]).toEqual({
      originIndex: 1,
      destinationIndex: 0,
      distanceMeters: 1500,
      durationSeconds: 90,
    });
  });

  it('should tolerate blank lines and trailing whitespace in NDJSON', async () => {
    const ndjsonBody =
      '\n  \n{"originIndex":0,"destinationIndex":0,"distanceMeters":100,"duration":"10s"}\n\n' +
      '{"originIndex":0,"destinationIndex":1,"distanceMeters":200,"duration":"20s"}\n';

    mockFetch.mockResolvedValueOnce(new Response(ndjsonBody, { status: 200 }));

    const result = await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
    });

    expect(result.cells).toHaveLength(2);
  });

  // failed cells (status.code !== 0) retained in raw but omitted from cells[]
  it('should omit failed cells from cells[] but retain them in raw', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 1000, duration: '60s' },
        {
          originIndex: 0,
          destinationIndex: 1,
          status: { code: 5, message: 'NOT_FOUND' },
        },
        { originIndex: 1, destinationIndex: 0, distanceMeters: 1500, duration: '90s' },
        {
          originIndex: 1,
          destinationIndex: 1,
          status: { code: 14, message: 'UNAVAILABLE' },
        },
      ]),
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

    // Two successful cells in `cells[]`
    expect(result.cells).toHaveLength(2);
    expect(result.cells.map((c) => [c.originIndex, c.destinationIndex])).toEqual([
      [0, 0],
      [1, 0],
    ]);

    // All four elements (including failed ones) retained in `raw`
    const raw = result.raw as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(4);
    expect(raw[1]).toMatchObject({
      originIndex: 0,
      destinationIndex: 1,
      status: { code: 5, message: 'NOT_FOUND' },
    });
  });

  it('should keep cells whose status.code === 0 (explicit OK)', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        {
          originIndex: 0,
          destinationIndex: 0,
          distanceMeters: 1000,
          duration: '60s',
          status: { code: 0, message: 'OK' },
        },
      ]),
    );

    const result = await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
    });

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.distanceMeters).toBe(1000);
  });

  it('omits a status-OK cell whose condition is ROUTE_NOT_FOUND', async () => {
    // Google may return an element with status OK (or absent) but
    // condition=ROUTE_NOT_FOUND and no distance/duration — it must be omitted,
    // not fabricated as a 0m/0s cell.
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        {
          originIndex: 0,
          destinationIndex: 0,
          distanceMeters: 1000,
          duration: '60s',
          condition: 'ROUTE_EXISTS',
        },
        {
          originIndex: 0,
          destinationIndex: 1,
          condition: 'ROUTE_NOT_FOUND',
        },
      ]),
    );

    const result = await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
    });

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.destinationIndex).toBe(0);
  });

  // duration parsing ("123s" → 123) and distanceMeters passthrough
  it('should parse Google duration format and pass distanceMeters through unchanged', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 12345, duration: '678s' },
      ]),
    );

    const result = await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
    });

    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      distanceMeters: 12345,
      durationSeconds: 678,
    });
  });

  // _passthrough merge via mergePassthrough (4-arg form)
  it('should deep-merge _passthrough body and shallow-merge headers', async () => {
    mockFetch.mockResolvedValueOnce(buildNdjsonResponse([]));

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      avoidTolls: true,
      _passthrough: {
        body: { routeModifiers: { vehicleInfo: { emissionType: 'GASOLINE' } } },
        headers: { 'X-Custom': 'value' },
      },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routeModifiers).toEqual(
      expect.objectContaining({
        avoidTolls: true,
        vehicleInfo: { emissionType: 'GASOLINE' },
      }),
    );
    expect((init?.headers as Record<string, string>)?.['X-Custom']).toBe('value');
  });

  describe('mapVendorError mapping table', () => {
    it.each<[number, Record<string, unknown> | null, string]>([
      [401, null, 'auth_failed'],
      [403, { error: { status: 'PERMISSION_DENIED' } }, 'auth_failed'],
      [403, { error: { status: 'QUOTA_EXCEEDED' } }, 'rate_limited'],
      [403, null, 'auth_failed'],
      [429, null, 'rate_limited'],
      [400, { error: { message: 'bad request' } }, 'invalid_request'],
      // google.rpc.ErrorInfo reason wins over the 400 status:
      [400, { error: { status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }, 'auth_failed'],
      [400, { error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com' }] } }, 'rate_limited'],
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

  it('should throw ConnectorError on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Bad request' } }), {
        status: 400,
      }),
    );

    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  // Retry-After surface (no structured retryAfterSeconds field per feedback memory)
  it('should surface Retry-After header in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
        { status: 429, headers: { 'Retry-After': '30' } },
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
    expect(caught?.providerMessage).toBe('Quota exceeded; retry after 30 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('30');
    // No structured retryAfterSeconds field by design
    expect((caught as unknown as Record<string, unknown>)?.retryAfterSeconds).toBeUndefined();
  });

  it('should attach retryAfter to cause even when error body is null', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'Retry-After': '15' } }),
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
    expect(caught?.providerMessage).toBe('retry after 15 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('15');
  });
});
