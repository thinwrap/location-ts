import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleRoutingConnector } from './google.routing.connector';
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

function buildRoutesResponse(opts?: { optimized?: boolean }) {
  return new Response(
    JSON.stringify({
      routes: [
        {
          legs: [
            { distanceMeters: 5000, duration: '300s', staticDuration: '300s' },
            { distanceMeters: 3000, duration: '180s', staticDuration: '180s' },
          ],
          distanceMeters: 8000,
          duration: '480s',
          staticDuration: '480s',
          polyline: { encodedPolyline: 'abc123encoded' },
          ...(opts?.optimized
            ? { optimizedIntermediateWaypointIndex: [1, 0] }
            : {}),
        },
      ],
    }),
    { status: 200 },
  );
}

describe('GoogleRoutingConnector', () => {
  let connector: GoogleRoutingConnector;

  beforeEach(() => {
    connector = new GoogleRoutingConnector(defaultConfig);
  });

  it('should have providerId "google"', () => {
    expect(connector.providerId).toBe('google');
  });

  it('should POST to Routes v2 with correct headers and body', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    const result = await connector.route({
      waypoints: [
        { lat: 40.7128, lng: -74.006 },
        { lat: 40.758, lng: -73.9855 },
        { lat: 40.7484, lng: -73.9856 },
      ],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;

    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        'X-Goog-Api-Key': 'test-api-key',
        'Content-Type': 'application/json',
      }),
    );
    expect((init?.headers as Record<string, string>)?.['X-Goog-FieldMask']).toBeDefined();

    const parsedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(parsedBody.travelMode).toBe('DRIVE');
    expect(parsedBody.origin).toBeDefined();
    expect(parsedBody.destination).toBeDefined();
    expect(parsedBody.intermediates).toHaveLength(1);

    expect(result.totalDistanceMeters).toBe(8000);
    expect(result.totalDurationSeconds).toBe(480);
    expect(result.legs).toHaveLength(2);
    expect(result.polyline).toBe('abc123encoded');
  });

  it('should send optimizeWaypointOrder when optimize=true', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse({ optimized: true }));

    const result = await connector.route({
      waypoints: [
        { lat: 40.7128, lng: -74.006 },
        { lat: 40.758, lng: -73.9855 },
        { lat: 40.7614, lng: -73.9776 },
        { lat: 40.7484, lng: -73.9856 },
      ],
      optimize: true,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.optimizeWaypointOrder).toBe(true);
    // Canonical waypointOrder = full visiting sequence of INPUT indices.
    // 4 input waypoints; Google reports optimizedIntermediateWaypointIndex
    // [1,0] (intermediates reordered). Project to absolute (i+1), prepend
    // origin 0, append destination 3 ⇒ [0,2,1,3].
    expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
  });

  it('should map travel modes correctly', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    await connector.route({
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      travelMode: 'walking',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.travelMode).toBe('WALK');
  });

  it('should include routeModifiers when avoid options are set', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    await connector.route({
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      avoidTolls: true,
      avoidHighways: true,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routeModifiers).toEqual(
      expect.objectContaining({
        avoidTolls: true,
        avoidHighways: true,
      }),
    );
  });

  it('should set TRAFFIC_AWARE routing when departureTime is provided', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    await connector.route({
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      departureTime: new Date('2024-01-15T08:00:00Z'),
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.departureTime).toBe('2024-01-15T08:00:00.000Z');
  });

  it('should merge passthrough body and headers', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    await connector.route({
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      _passthrough: {
        body: { languageCode: 'fr' },
        headers: { 'X-Custom': 'value' },
      },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.languageCode).toBe('fr');
    expect((init?.headers as Record<string, string>)?.['X-Custom']).toBe('value');
  });

  it('should deep-merge passthrough body into nested routeModifiers (Decision 4.4)', async () => {
    mockFetch.mockResolvedValueOnce(buildRoutesResponse());

    await connector.route({
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      avoidTolls: true,
      _passthrough: {
        body: { routeModifiers: { vehicleInfo: { emissionType: 'GASOLINE' } } },
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
  });

  it('should throw ConnectorError with auth_failed providerCode on HTTP 403 PERMISSION_DENIED', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'API key invalid' } }),
        { status: 403 },
      ),
    );

    await expect(
      connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'auth_failed',
      statusCode: 403,
      providerMessage: 'API key invalid',
    });
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
          connector.route({
            waypoints: [
              { lat: 0, lng: 0 },
              { lat: 1, lng: 1 },
            ],
          }),
        ).rejects.toMatchObject({
          name: 'ConnectorError',
          providerCode: expectedCode,
          statusCode: status,
        });
      },
    );
  });

  it('should surface Retry-After header in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
        { status: 429, headers: { 'Retry-After': '30' } },
      ),
    );

    let caught: ConnectorError | null = null;
    try {
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
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
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught?.providerCode).toBe('rate_limited');
    expect(caught?.providerMessage).toBe('retry after 15 seconds');
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('15');
  });

  // Success-path malformed body: 200 OK whose JSON fails to parse → the
  // `.catch(() => null)` yields null and we surface a typed ConnectorError
  // rather than an uncaught SyntaxError.
  it('should throw ConnectorError on a malformed (non-JSON) 200 body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    let caught: ConnectorError | null = null;
    try {
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('unknown');
    expect(caught?.message).toBe('Google Routing returned a malformed response body');
  });

  it('rejects a non-finite waypoint with ConnectorError invalid_request (no fetch)', async () => {
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

  it('rejects an Infinity waypoint with ConnectorError invalid_request (no fetch)', async () => {
    await expect(
      connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: Number.POSITIVE_INFINITY },
        ],
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // A contract-violating 200 body (route present but missing nested
  // polyline/duration/legs) must normalize to safe defaults, not escape as an
  // unwrapped TypeError.
  it('normalizes a 200 body with a route missing nested fields to defaults', async () => {
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
    expect(result.polyline).toBe('');
  });
});
