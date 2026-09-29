import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TomTomMatrixConnector } from './tomtom.matrix.connector';
import type { TomTomConfig } from './tomtom.config';
import { ConnectorError } from '../../types';
import type { LatLng } from '../../types';

const mockFetch = vi.fn();

// Sleep injection used by the connector — tests pass a no-op to compress the
// polling loop without using fake timers.
const noopSleep = async (): Promise<void> => undefined;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: TomTomConfig = { apiKey: 'test-key' };

function syncBodyResp(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          originIndex: 0,
          destinationIndex: 0,
          routeSummary: { lengthInMeters: 5000, travelTimeInSeconds: 300 },
        },
        {
          originIndex: 0,
          destinationIndex: 1,
          routeSummary: { lengthInMeters: 8000, travelTimeInSeconds: 600 },
        },
      ],
      statistics: { totalCount: 2, successes: 2, failures: 0 },
    }),
    { status: 200 },
  );
}

function submitResp(jobId = 'job-abc'): Response {
  return new Response(JSON.stringify({ jobId }), { status: 200 });
}

function pendingResp(): Response {
  return new Response(JSON.stringify({ state: 'Running' }), { status: 200 });
}

function succeededResp(): Response {
  return new Response(JSON.stringify({ state: 'Completed' }), { status: 200 });
}

/**
 * Build a list of `count` coordinates so we can synthesize an `origins ×
 * destinations` matrix above the 100-cell sync threshold without enumerating each
 * pair by hand.
 */
function coords(count: number): LatLng[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 52 + i * 0.001,
    lng: 13 + i * 0.001,
  }));
}

/**
 * Build a COMPLETE `data[]` payload covering every cell of an `numOrigins ×
 * numDestinations` grid. Threshold-driven dispatch tests need a payload that
 * reads as a full answer for their (necessarily large) grids.
 */
function fullDataResp(numOrigins: number, numDestinations: number): Response {
  const data: Array<{
    originIndex: number;
    destinationIndex: number;
    routeSummary: { lengthInMeters: number; travelTimeInSeconds: number };
  }> = [];
  for (let oi = 0; oi < numOrigins; oi++) {
    for (let di = 0; di < numDestinations; di++) {
      data.push({
        originIndex: oi,
        destinationIndex: di,
        routeSummary: { lengthInMeters: 1000, travelTimeInSeconds: 60 },
      });
    }
  }
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('TomTomMatrixConnector', () => {
  let connector: TomTomMatrixConnector;

  beforeEach(() => {
    connector = new TomTomMatrixConnector(defaultConfig, undefined, noopSleep);
  });

  it('should have providerId "tomtom"', () => {
    expect(connector.providerId).toBe('tomtom');
  });

  // ===== sync dispatch (cell count <= 100) =====

  it('should dispatch sync POST when cell count <= 100 and parse data[] directly', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());

    const result = await connector.matrix({
      origins: [{ lat: 52.53, lng: 13.38 }],
      destinations: [
        { lat: 52.51, lng: 13.39 },
        { lat: 52.5, lng: 13.4 },
      ],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;

    // Sync endpoint, NOT /async
    expect(url as string).toContain('https://api.tomtom.com/routing/matrix/2');
    expect(url as string).not.toContain('/async');
    expect(url as string).toContain('key=test-key');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect((body.origins as unknown[]).length).toBe(1);
    expect((body.destinations as unknown[]).length).toBe(2);
    expect((body.options as Record<string, unknown>).travelMode).toBe('car');

    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      distanceMeters: 5000,
      durationSeconds: 300,
    });
    expect(result.cells[1]!.distanceMeters).toBe(8000);
  });

  it('should send `point: { latitude, longitude }` shape in body', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());

    await connector.matrix({
      origins: [{ lat: 52.53, lng: 13.38 }],
      destinations: [{ lat: 52.51, lng: 13.39 }],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.origins).toEqual([
      { point: { latitude: 52.53, longitude: 13.38 } },
    ]);
  });

  // A cell dropped for lacking `routeSummary` (an unroutable pair) is OMITTED
  // from the result — each returned cell is indexed, so the consumer can tell
  // which pairs are present. Parity with Mapbox/OSRM/HERE/Google.
  it('should omit a sync entry that lacks routeSummary (sparse grid)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              originIndex: 0,
              destinationIndex: 0,
              routeSummary: { lengthInMeters: 5000, travelTimeInSeconds: 300 },
            },
            {
              originIndex: 0,
              destinationIndex: 1,
              detailedError: { code: 'NO_ROUTE', message: 'No route found' },
            },
          ],
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
    expect(result.cells).toEqual([
      { originIndex: 0, destinationIndex: 0, distanceMeters: 5000, durationSeconds: 300 },
    ]);
  });

  it.each<['driving' | 'walking', string]>([
    ['driving', 'car'],
    ['walking', 'pedestrian'],
  ])('should map travelMode %s to %s', async (input, expected) => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: input,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect((body.options as Record<string, unknown>).travelMode).toBe(expected);
  });

  // cycling is absent from TomTom Matrix v2, so it raises a typed
  // unsupported_travel_mode error rather than silently degrading to 'bicycle'.
  it('should throw unsupported_travel_mode for cycling', async () => {
    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
        travelMode: 'cycling',
      }),
    ).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'unsupported_travel_mode',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should attach `avoid: ["tollRoads"]` when avoidTolls=true', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      avoidTolls: true,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect((body.options as Record<string, unknown>).avoid).toEqual([
      'tollRoads',
    ]);
  });

  // ===== async dispatch (cell count > 100) =====

  it('should dispatch async submit → poll → retrieve when cell count > 100', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-xyz'))
      .mockResolvedValueOnce(pendingResp())
      .mockResolvedValueOnce(succeededResp())
      // Full 51×51 payload, so every requested cell is present.
      .mockResolvedValueOnce(fullDataResp(51, 51));

    // 51 × 51 = 2601 cells, well above the sync threshold
    const origins = coords(51);
    const destinations = coords(51);

    const result = await connector.matrix({ origins, destinations });

    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Call 1: submit POST /async
    const [submitUrl, submitInit] = mockFetch.mock.calls[0]!;
    expect(submitInit?.method).toBe('POST');
    expect(submitUrl as string).toContain(
      'https://api.tomtom.com/routing/matrix/2/async',
    );
    expect(submitUrl as string).toContain('key=test-key');

    // Calls 2 + 3: poll GET /async/{jobId}
    const [poll1Url, poll1Init] = mockFetch.mock.calls[1]!;
    expect(poll1Init?.method).toBe('GET');
    expect(poll1Url as string).toContain(
      'https://api.tomtom.com/routing/matrix/2/async/job-xyz',
    );
    expect(poll1Url as string).not.toContain('/result');
    expect(poll1Url as string).toContain('key=test-key');
    expect(mockFetch.mock.calls[2]![1]?.method).toBe('GET');

    // Call 4: retrieve GET /async/{jobId}/result
    const [retrieveUrl, retrieveInit] = mockFetch.mock.calls[3]!;
    expect(retrieveInit?.method).toBe('GET');
    expect(retrieveUrl as string).toContain(
      'https://api.tomtom.com/routing/matrix/2/async/job-xyz/result',
    );
    expect(retrieveUrl as string).toContain('key=test-key');

    expect(result.cells).toHaveLength(2601);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      distanceMeters: 1000,
      durationSeconds: 60,
    });
  });

  it('should accept immediate Completed state on first poll (async path)', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-fast'))
      .mockResolvedValueOnce(succeededResp())
      .mockResolvedValueOnce(fullDataResp(51, 51));

    const result = await connector.matrix({
      origins: coords(51),
      destinations: coords(51),
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.cells).toHaveLength(2601);
  });

  it('should use sync path exactly at the 100-cell boundary', async () => {
    mockFetch.mockResolvedValueOnce(fullDataResp(10, 10));

    // 10 × 10 = 100 — TomTom's default synchronous maximum; stays sync
    // (single fetch, sync URL).
    await connector.matrix({
      origins: coords(10),
      destinations: coords(10),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    expect(url as string).toBe('https://api.tomtom.com/routing/matrix/2?key=test-key');
  });

  it('should switch to the async path at 101 cells', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-101'))
      .mockResolvedValueOnce(succeededResp())
      .mockResolvedValueOnce(fullDataResp(101, 1));

    // 101 × 1 = 101 — one cell past the synchronous maximum.
    const result = await connector.matrix({
      origins: coords(101),
      destinations: coords(1),
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0]![0] as string).toContain(
      'https://api.tomtom.com/routing/matrix/2/async',
    );
    expect(result.cells).toHaveLength(101);
  });

  // ===== polling deadline =====

  it('should throw matrix_polling_timeout with cause.jobId on deadline expiry', async () => {
    // Submit succeeds; every subsequent fetch is a 'Running' pending response.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/async/') && !url.includes('/result')) {
        return Promise.resolve(pendingResp());
      }
      return Promise.resolve(submitResp('job-timeout'));
    });

    let caught: ConnectorError | null = null;
    try {
      await connector.matrix({
        origins: coords(51),
        destinations: coords(51),
        // tight deadline → noopSleep means deadline expires immediately on the
        // first iteration that finds Date.now() >= deadlineAt
        _passthrough: { body: { timeoutMs: 1 } },
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('matrix_polling_timeout');
    expect(caught?.statusCode).toBeNull();
    expect(caught?.providerMessage).toContain('job-timeout');
    expect((caught?.cause as { jobId?: string })?.jobId).toBe('job-timeout');
  });

  // A deadline that is not a finite positive number of milliseconds is refused
  // rather than coerced (parseInt of a string) or replaced by the 60 s default.
  it.each([
    ['a numeric string', '5000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative number', -1],
    ['null', null],
  ])('rejects timeoutMs given as %s before any request', async (_label, timeoutMs) => {
    for (const size of [2, 51]) {
      await expect(
        connector.matrix({
          origins: coords(size),
          destinations: coords(size),
          _passthrough: { body: { timeoutMs } },
        }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should strip timeoutMs from the submit body (wrapper-side knob)', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-strip'))
      .mockResolvedValueOnce(succeededResp())
      .mockResolvedValueOnce(fullDataResp(51, 51));

    await connector.matrix({
      origins: coords(51),
      destinations: coords(51),
      _passthrough: { body: { timeoutMs: 30_000 } },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.timeoutMs).toBeUndefined();
  });

  // ===== Failed-state on async path =====

  it('should throw provider_unavailable when async state=Failed', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-failed'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ state: 'Failed', reason: 'computation error' }),
          { status: 200 },
        ),
      );

    let caught: ConnectorError | null = null;
    try {
      await connector.matrix({
        origins: coords(51),
        destinations: coords(51),
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('provider_unavailable');
    expect(caught?.message).toBe('TomTom Matrix job failed');
  });

  // ===== mapVendorError =====

  describe('mapVendorError mapping table (sync phase)', () => {
    it.each<[number, string]>([
      [401, 'auth_failed'],
      [403, 'auth_failed'],
      [429, 'rate_limited'],
      [400, 'invalid_request'],
      [404, 'invalid_request'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
      [418, 'unknown'],
    ])('HTTP %i maps to providerCode %s', async (status, expectedCode) => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'err' }), { status }),
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

      expect(caught?.providerCode).toBe(expectedCode);
      expect(caught?.statusCode).toBe(status);
    });
  });

  it('should surface Retry-After in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { description: 'Rate limited - quota exceeded' },
        }),
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
    expect(caught?.providerMessage).toBe(
      'Rate limited - quota exceeded; retry after 45 seconds',
    );
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('45');
    // No structured retryAfterSeconds field by design
    expect(
      (caught as unknown as Record<string, unknown>)?.retryAfterSeconds,
    ).toBeUndefined();
  });

  it('should raise ConnectorError when async poll returns non-2xx', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp('job-poll-err'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Server error' }), { status: 503 }),
      );

    let caught: ConnectorError | null = null;
    try {
      await connector.matrix({
        origins: coords(51),
        destinations: coords(51),
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('provider_unavailable');
    expect(caught?.statusCode).toBe(503);
    expect(caught?.message).toContain('TomTom Matrix poll');
  });

  it('should throw unknown when async submit response is missing jobId', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    let caught: ConnectorError | null = null;
    try {
      await connector.matrix({
        origins: coords(51),
        destinations: coords(51),
      });
    } catch (err) {
      caught = err as ConnectorError;
    }

    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught?.providerCode).toBe('unknown');
  });

  // ===== trafficMode =====

  // `traffic` is always sent: TomTom's default is `historical`, so `'live'`
  // has to be asked for.
  it.each([
    ['unset', undefined, 'historical'],
    ['none', 'none' as const, 'historical'],
    ['live', 'live' as const, 'live'],
  ])('sends options.traffic for trafficMode %s', async (_label, trafficMode, expected) => {
    for (const size of [1, 11]) {
      mockFetch.mockReset();
      if (size === 1) {
        mockFetch.mockResolvedValueOnce(syncBodyResp());
      } else {
        mockFetch
          .mockResolvedValueOnce(submitResp('job-traffic'))
          .mockResolvedValueOnce(succeededResp())
          .mockResolvedValueOnce(fullDataResp(11, 11));
      }
      await connector.matrix({
        origins: coords(size),
        destinations: coords(size),
        ...(trafficMode !== undefined ? { trafficMode } : {}),
      });
      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
        options: Record<string, unknown>;
      };
      expect(body.options.traffic).toBe(expected);
    }
  });

  // TomTom rejects `traffic: live` with `departAt: any`, its own default.
  it('departs now for a live request without a departure time', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());
    await connector.matrix({
      origins: coords(1),
      destinations: coords(1),
      trafficMode: 'live',
    });
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
      options: Record<string, unknown>;
    };
    expect(body.options.departAt).toBe('now');
  });

  it('keeps the caller departure time on a live request', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());
    await connector.matrix({
      origins: coords(1),
      destinations: coords(1),
      trafficMode: 'live',
      departureTime: new Date('2026-10-01T08:00:00Z'),
    });
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
      options: Record<string, unknown>;
    };
    expect(body.options).toMatchObject({
      traffic: 'live',
      departAt: '2026-10-01T08:00:00.000Z',
    });
  });

  it('keeps 100 cells on the sync endpoint whatever the traffic mode', async () => {
    mockFetch.mockResolvedValueOnce(fullDataResp(10, 10));
    await connector.matrix({ origins: coords(10), destinations: coords(10), trafficMode: 'live' });
    expect(mockFetch.mock.calls[0]![0] as string).not.toContain('/async');
  });

  // ===== _passthrough merge (mergePassthrough 4-arg form) =====

  it('should deep-merge _passthrough body and shallow-merge headers + query', async () => {
    mockFetch.mockResolvedValueOnce(syncBodyResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: {
        body: { options: { vehicleMaxSpeed: 80 } },
        headers: { 'X-Custom': 'val' },
        query: { extraParam: 'extraVal' },
      },
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    // deep-merge: connector's options.travelMode preserved, passthrough's
    // field layered on top
    expect(body.options).toMatchObject({ travelMode: 'car', vehicleMaxSpeed: 80 });
    expect((init?.headers as Record<string, string>)?.['X-Custom']).toBe('val');
    expect(url as string).toContain('extraParam=extraVal');
  });

  // Backwards-compat smoke: ConnectorError is thrown on sync failure
  it('should throw ConnectorError on sync 400', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }),
    );

    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  // A cell without routeSummary is a failed pair: omitted, never zero-filled.
  // A body without a readable `data` list is not an empty matrix, on either
  // path.
  describe('malformed 2xx bodies', () => {
    it.each([
      ['no data field', { statistics: {} }],
      ['a non-array data', { data: { originIndex: 0 } }],
      ['a null cell', { data: [null] }],
      [
        'a summary without numbers',
        { data: [{ originIndex: 0, destinationIndex: 0, routeSummary: { lengthInMeters: 1 } }] },
      ],
    ])('raises unknown for %s on the sync path', async (_label, body) => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(
        connector.matrix({ origins: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] }),
      ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200, cause: body });
    });

    it('raises unknown for a retrieve body without data on the async path', async () => {
      mockFetch
        .mockResolvedValueOnce(submitResp('job-empty'))
        .mockResolvedValueOnce(succeededResp())
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await expect(
        connector.matrix({ origins: coords(11), destinations: coords(11) }),
      ).rejects.toMatchObject({ providerCode: 'unknown' });
    });
  });

  describe('matrix sparse-cell omission', () => {
    it('omits an unroutable cell (returns a sparse, indexed result) rather than throwing', async () => {
      // 1×2 grid requested, but only one cell carries a routeSummary; the other
      // is unreachable (detailedError). The unroutable pair is OMITTED — each
      // returned cell is indexed, so the consumer can tell which pairs exist,
      // the same cell-omission rule as Mapbox/OSRM/HERE/Google.
      const body = {
        data: [
          {
            originIndex: 0,
            destinationIndex: 0,
            routeSummary: { lengthInMeters: 5000, travelTimeInSeconds: 300 },
          },
          {
            originIndex: 0,
            destinationIndex: 1,
            detailedError: { code: 'NO_ROUTE', message: 'unreachable' },
          },
        ],
        statistics: { totalCount: 2, successes: 1, failures: 1 },
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

      expect(result.cells).toEqual([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 5000, durationSeconds: 300 },
      ]);
    });

    it('does not throw when every requested cell is routable (happy path unchanged)', async () => {
      // 1×2 grid, both cells routable — must still succeed.
      const result = await (async () => {
        mockFetch.mockResolvedValueOnce(syncBodyResp());
        return connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
        });
      })();
      expect(result.cells).toHaveLength(2);
    });
  });
});
