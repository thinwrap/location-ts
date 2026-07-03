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

  // HTTP call shape: URL, method, headers, body
  it('should POST to RouteMatrix v2 with correct URL, headers, and body shape', async () => {
    mockFetch.mockResolvedValueOnce(
      buildNdjsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 1000, duration: '60s' },
        { originIndex: 0, destinationIndex: 1, distanceMeters: 2000, duration: '120s' },
        { originIndex: 1, destinationIndex: 0, distanceMeters: 1500, duration: '90s' },
        { originIndex: 1, destinationIndex: 1, distanceMeters: 500, duration: '30s' },
      ]),
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

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;

    expect(url).toBe(
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        'X-Goog-Api-Key': 'test-api-key',
        'Content-Type': 'application/json',
      }),
    );
    expect((init?.headers as Record<string, string>)?.['X-Goog-FieldMask']).toBe(
      'originIndex,destinationIndex,distanceMeters,duration,status',
    );

    const parsedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
    const origins = parsedBody.origins as Array<Record<string, unknown>>;
    const destinations = parsedBody.destinations as Array<Record<string, unknown>>;
    expect(origins).toHaveLength(2);
    expect(destinations).toHaveLength(2);
    expect(origins[0]).toEqual({
      waypoint: { location: { latLng: { latitude: 40.7128, longitude: -74.006 } } },
    });
    expect(parsedBody.travelMode).toBe('DRIVE');
    // routingPreference default (no departureTime) is TRAFFIC_UNAWARE
    expect(parsedBody.routingPreference).toBe('TRAFFIC_UNAWARE');

    expect(result.cells).toHaveLength(4);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      distanceMeters: 1000,
      durationSeconds: 60,
    });
  });

  // routingPreference TRAFFIC_AWARE when departureTime is set
  it('should set routingPreference TRAFFIC_AWARE when departureTime is provided', async () => {
    mockFetch.mockResolvedValueOnce(buildNdjsonResponse([]));

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      departureTime: new Date('2026-05-17T08:00:00Z'),
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.departureTime).toBe('2026-05-17T08:00:00.000Z');
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

  // mapVendorError mapping table
  describe('mapVendorError mapping table', () => {
    it.each<[number, Record<string, unknown> | null, string]>([
      [401, null, 'auth_failed'],
      [403, { error: { status: 'PERMISSION_DENIED' } }, 'auth_failed'],
      [403, { error: { status: 'QUOTA_EXCEEDED' } }, 'rate_limited'],
      [403, null, 'auth_failed'],
      [429, null, 'rate_limited'],
      [400, { error: { message: 'bad request' } }, 'invalid_request'],
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
