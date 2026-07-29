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

  describe('waypointOrder permutation guard', () => {
    function buildWithOptimizedIndex(optimizedIntermediateWaypointIndex: unknown) {
      return new Response(
        JSON.stringify({
          routes: [
            {
              legs: [{ distanceMeters: 5000, duration: '300s' }],
              distanceMeters: 8000,
              duration: '480s',
              polyline: { encodedPolyline: 'abc123encoded' },
              optimizedIntermediateWaypointIndex,
            },
          ],
        }),
        { status: 200 },
      );
    }

    const fourWaypoints = [
      { lat: 40.7128, lng: -74.006 },
      { lat: 40.758, lng: -73.9855 },
      { lat: 40.7614, lng: -73.9776 },
      { lat: 40.7484, lng: -73.9856 },
    ];

    // Google answers `[-1]` when it declines to optimize. Projected that is
    // [0, 0, 3] — the origin duplicated and waypoints 1 and 2 dropped. Emitting
    // it corrupted the consumer's own reordering, so it must be omitted.
    it('omits waypointOrder for the [-1] sentinel', async () => {
      mockFetch.mockResolvedValueOnce(buildWithOptimizedIndex([-1]));

      const result = await connector.route({
        waypoints: fourWaypoints,
        optimize: true,
      });

      expect(result.waypointOrder).toBeUndefined();
      // The rest of the result is still returned — the route itself is valid.
      expect(result.totalDistanceMeters).toBe(8000);
      expect(result.raw).toBeDefined();
    });

    it.each([
      ['a short intermediate list', [0]],
      ['duplicate intermediates', [0, 0]],
      ['an out-of-range intermediate', [1, 9]],
      ['a non-integer intermediate', [0, 1.5]],
      ['a non-numeric intermediate', [0, 'x']],
      ['an all-sentinel list', [-1, -1]],
    ])('omits waypointOrder for %s', async (_label, optimizedIndex) => {
      mockFetch.mockResolvedValueOnce(buildWithOptimizedIndex(optimizedIndex));

      const result = await connector.route({
        waypoints: fourWaypoints,
        optimize: true,
      });

      expect(result.waypointOrder).toBeUndefined();
    });

    it('keeps a valid round-trip ordering (no destination appended)', async () => {
      mockFetch.mockResolvedValueOnce(buildWithOptimizedIndex([2, 0, 1]));

      const result = await connector.route({
        waypoints: fourWaypoints,
        isRoundTrip: true,
      });

      // For a round trip every non-origin waypoint is an intermediate, so
      // origin + projected intermediates already covers all four inputs.
      expect(result.waypointOrder).toEqual([0, 3, 1, 2]);
    });

    it('omits a round-trip ordering that is not a complete permutation', async () => {
      mockFetch.mockResolvedValueOnce(buildWithOptimizedIndex([-1]));

      const result = await connector.route({
        waypoints: fourWaypoints,
        isRoundTrip: true,
      });

      expect(result.waypointOrder).toBeUndefined();
    });
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
    // Google rejects routingPreference for WALK/BICYCLE — it must be omitted.
    expect(body.routingPreference).toBeUndefined();
  });

  // The billing fix. `TRAFFIC_AWARE` is a Pro-tier SKU feature on Compute Routes;
  // deriving it from `departureTime` meant asking for a future departure silently
  // moved the caller to Pro pricing. It is now driven only by `trafficMode`.
  describe('trafficMode and the Pro-tier SKU', () => {
    function bodyOf(): Record<string, unknown> {
      const [, init] = mockFetch.mock.calls[0]!;
      return JSON.parse(init!.body as string) as Record<string, unknown>;
    }

    const TWO = [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ];

    it('defaults to TRAFFIC_UNAWARE', async () => {
      mockFetch.mockResolvedValueOnce(buildRoutesResponse());
      await connector.route({ waypoints: TWO });
      expect(bodyOf().routingPreference).toBe('TRAFFIC_UNAWARE');
    });

    it('stays TRAFFIC_UNAWARE when departureTime alone is given', async () => {
      mockFetch.mockResolvedValueOnce(buildRoutesResponse());
      await connector.route({
        waypoints: TWO,
        departureTime: new Date('2026-01-01T12:00:00Z'),
      });
      const body = bodyOf();
      // The departure time is still sent — it affects historical/scheduled
      // routing — but it no longer upgrades the SKU on its own.
      expect(body.departureTime).toBe('2026-01-01T12:00:00.000Z');
      expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    });

    it('sends TRAFFIC_AWARE only when trafficMode is "live"', async () => {
      mockFetch.mockResolvedValueOnce(buildRoutesResponse());
      await connector.route({ waypoints: TWO, trafficMode: 'live' });
      expect(bodyOf().routingPreference).toBe('TRAFFIC_AWARE');
    });

    it('sends TRAFFIC_UNAWARE for an explicit trafficMode "none"', async () => {
      mockFetch.mockResolvedValueOnce(buildRoutesResponse());
      await connector.route({ waypoints: TWO, trafficMode: 'none' });
      expect(bodyOf().routingPreference).toBe('TRAFFIC_UNAWARE');
    });

    it('still omits routingPreference for walking regardless of trafficMode', async () => {
      mockFetch.mockResolvedValueOnce(buildRoutesResponse());
      await connector.route({
        waypoints: TWO,
        travelMode: 'walking',
        trafficMode: 'live',
      });
      expect(bodyOf().routingPreference).toBeUndefined();
    });
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
