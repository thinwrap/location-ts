import { gzipSync } from 'node:zlib';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HereMatrixConnector } from './here.matrix.connector';
import type { HereMatrixOptions } from './here.matrix.connector';
import type { HereConfig } from './here.config';
import { ConnectorError } from '../../types';

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

const defaultConfig: HereConfig = { apiKey: 'test-here-key' };

function submitResp(
  matrixId = 'm1',
  statusUrl = 'https://matrix.router.hereapi.com/v8/status/m1',
): Response {
  return new Response(JSON.stringify({ matrixId, statusUrl }), { status: 200 });
}

function pendingResp(): Response {
  return new Response(JSON.stringify({ status: 'inProgress' }), { status: 200 });
}

// Real HERE v8 completion: HTTP 303 See Other with a `Location` response
// header AND a body `{matrixId, status:"completed", resultUrl}`.
function completedResp(
  resultUrl = 'https://aws-eu-west-1.matrix.router.hereapi.com/v8/result/m1',
): Response {
  return new Response(
    JSON.stringify({ matrixId: 'm1', status: 'completed', resultUrl }),
    { status: 303, headers: { Location: resultUrl } },
  );
}

type HereMatrixPayload = {
  numOrigins: number;
  numDestinations: number;
  travelTimes: number[];
  distances: number[];
  errorCodes?: number[];
};

const DEFAULT_MATRIX: HereMatrixPayload = {
  numOrigins: 2,
  numDestinations: 2,
  travelTimes: [0, 120, 130, 0],
  distances: [0, 2000, 2100, 0],
};

// Plain (uncompressed) retrieve body — models a transport that already
// decompressed the result (no gzip magic / no Content-Encoding).
function resultResp(matrix: HereMatrixPayload = DEFAULT_MATRIX): Response {
  return new Response(JSON.stringify({ matrix }), { status: 200 });
}

// Real HERE retrieve body: gzip-compressed with `Content-Encoding: gzip`. Locks
// in the connector's defensive gunzip path (undici does not auto-decompress
// once the connector sets Accept-Encoding itself).
function gzResultResp(matrix: HereMatrixPayload = DEFAULT_MATRIX): Response {
  const gz = gzipSync(Buffer.from(JSON.stringify({ matrix })));
  return new Response(gz, {
    status: 200,
    headers: { 'Content-Encoding': 'gzip' },
  });
}

// Real HERE retrieve step 1: the resultUrl (a hereapi.com host) does NOT return
// the payload inline — it 303-redirects to a pre-signed S3 object URL.
const S3_RESULT_URL =
  'https://s3.eu-west-1.amazonaws.com/here-routing-large-matrix-prd-eu-west-1/deadbeef.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';
function resultRedirectResp(location = S3_RESULT_URL): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

describe('HereMatrixConnector', () => {
  let connector: HereMatrixConnector;

  beforeEach(() => {
    connector = new HereMatrixConnector(defaultConfig, undefined, noopSleep);
  });

  it('should have providerId "here"', () => {
    expect(connector.providerId).toBe('here');
  });

  it('omits cells HERE flags via errorCodes (unspecified value), keeping code 0/3', async () => {
    // errorCodes parallels travelTimes/distances: 0 OK, 3 usable-with-violation,
    // any other non-zero marks the cell value as unspecified → must be omitted.
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(
        resultResp({
          numOrigins: 2,
          numDestinations: 2,
          travelTimes: [0, 120, 0, 0],
          distances: [0, 2000, 0, 0],
          // (0,0) OK; (0,1) OK; (1,0) failed with code 4 → omitted; (1,1) code 3 kept.
          errorCodes: [0, 0, 4, 3],
        }),
      );

    const result = await connector.matrix({
      origins: [
        { lat: 52.53, lng: 13.38 },
        { lat: 52.52, lng: 13.4 },
      ],
      destinations: [
        { lat: 52.51, lng: 13.39 },
        { lat: 52.5, lng: 13.41 },
      ],
    });

    expect(result.cells).toHaveLength(3);
    expect(
      result.cells.some((c) => c.originIndex === 1 && c.destinationIndex === 0),
    ).toBe(false);
    expect(
      result.cells.some((c) => c.originIndex === 1 && c.destinationIndex === 1),
    ).toBe(true);
  });

  // full submit → poll(pending) → poll(completed) → retrieve cycle
  it('should run submit → poll → retrieve cycle and flatten 2D grid to cells[]', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(pendingResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    const result = await connector.matrix({
      origins: [
        { lat: 52.53, lng: 13.38 },
        { lat: 52.52, lng: 13.40 },
      ],
      destinations: [
        { lat: 52.51, lng: 13.39 },
        { lat: 52.50, lng: 13.41 },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Call 1: submit (POST, async=true)
    const [submitUrl, submitInit] = mockFetch.mock.calls[0]!;
    expect(submitInit?.method).toBe('POST');
    expect(submitUrl as string).toContain(
      'https://matrix.router.hereapi.com/v8/matrix',
    );
    expect(submitUrl as string).toContain('async=true');
    expect(submitUrl as string).toContain('apiKey=test-here-key');

    const submitBody = JSON.parse(submitInit!.body as string) as Record<
      string,
      unknown
    >;
    expect((submitBody.origins as unknown[]).length).toBe(2);
    expect((submitBody.destinations as unknown[]).length).toBe(2);
    expect(submitBody.regionDefinition).toEqual({ type: 'autoCircle' });
    expect(submitBody.matrixAttributes).toEqual(['travelTimes', 'distances']);

    // Calls 2 + 3: poll (GET to statusUrl). The poll must use redirect:'manual'
    // so the completion 303 is observable rather than a thrown network error.
    const [poll1Url, poll1Init] = mockFetch.mock.calls[1]!;
    expect(poll1Init?.method).toBe('GET');
    expect(poll1Init?.redirect).toBe('manual');
    expect(poll1Url as string).toContain(
      'https://matrix.router.hereapi.com/v8/status/m1',
    );
    expect(mockFetch.mock.calls[2]![1]?.method).toBe('GET');

    // Call 4: retrieve (GET to resultUrl on the aws-eu-west-1 result host) —
    // must carry the apiKey and Accept-Encoding: gzip.
    const [retrieveUrl, retrieveInit] = mockFetch.mock.calls[3]!;
    expect(retrieveInit?.method).toBe('GET');
    expect(retrieveUrl as string).toContain(
      'https://aws-eu-west-1.matrix.router.hereapi.com/v8/result/m1',
    );
    expect(retrieveUrl as string).toContain('apiKey=test-here-key');
    expect(
      (retrieveInit?.headers as Record<string, string>)?.['Accept-Encoding'],
    ).toBe('gzip');

    // 2x2 grid → 4 cells flatten
    expect(result.cells).toHaveLength(4);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      durationSeconds: 0,
      distanceMeters: 0,
    });
    expect(result.cells[1]).toEqual({
      originIndex: 0,
      destinationIndex: 1,
      durationSeconds: 120,
      distanceMeters: 2000,
    });
    expect(result.cells[2]).toEqual({
      originIndex: 1,
      destinationIndex: 0,
      durationSeconds: 130,
      distanceMeters: 2100,
    });
    expect(result.cells[3]).toEqual({
      originIndex: 1,
      destinationIndex: 1,
      durationSeconds: 0,
      distanceMeters: 0,
    });
  });

  // single completed poll (no pending phase)
  it('should accept immediate completion on first poll', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    const result = await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.cells).toHaveLength(1);
  });

  // 303-poll + GZIP-compressed retrieve body (real HERE shape) — locks in the
  // defensive gunzip path. distances are METERS, travelTimes SECONDS, used
  // as-is (no unit conversion).
  it('should decompress a gzipped retrieve body and normalize a cell', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(
        gzResultResp({
          numOrigins: 1,
          numDestinations: 1,
          travelTimes: [5427],
          distances: [109144],
        }),
      );

    const result = await connector.matrix({
      origins: [{ lat: 40.7484, lng: -73.9857 }],
      destinations: [{ lat: 41.1792, lng: -73.1952 }],
      travelMode: 'driving',
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.cells).toHaveLength(1);
    // meters + seconds used verbatim (no *1000 / *60 conversion)
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      durationSeconds: 5427,
      distanceMeters: 109144,
    });
  });

  // Real HERE retrieve is a DOUBLE redirect: the resultUrl (hereapi.com) itself
  // 303-redirects to a pre-signed S3 object URL that serves the gzip payload.
  // The apiKey must ride ONLY on the hereapi.com hop, never on the S3 hop.
  it('should follow the resultUrl → pre-signed S3 redirect and not leak the apiKey to S3', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultRedirectResp())
      .mockResolvedValueOnce(
        gzResultResp({
          numOrigins: 1,
          numDestinations: 1,
          travelTimes: [5427],
          distances: [109144],
        }),
      );

    const result = await connector.matrix({
      origins: [{ lat: 40.7484, lng: -73.9857 }],
      destinations: [{ lat: 41.1792, lng: -73.1952 }],
      travelMode: 'driving',
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Hop 1 (call 3): hereapi.com resultUrl — apiKey attached, manual redirect.
    const [hop1Url, hop1Init] = mockFetch.mock.calls[2]!;
    expect(hop1Init?.method).toBe('GET');
    expect(hop1Init?.redirect).toBe('manual');
    expect(hop1Url as string).toContain('hereapi.com');
    expect(hop1Url as string).toContain('apiKey=test-here-key');

    // Hop 2 (call 4): the pre-signed S3 URL — followed WITHOUT the apiKey.
    const [hop2Url, hop2Init] = mockFetch.mock.calls[3]!;
    expect(hop2Init?.method).toBe('GET');
    expect(hop2Url as string).toContain('s3.eu-west-1.amazonaws.com');
    expect(hop2Url as string).not.toContain('test-here-key');

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual({
      originIndex: 0,
      destinationIndex: 0,
      durationSeconds: 5427,
      distanceMeters: 109144,
    });
  });

  // travelMode mapping at the submit body level
  it.each<['driving' | 'walking' | 'cycling', string | undefined]>([
    ['driving', undefined], // 'car' is the default → omitted from body
    ['walking', 'pedestrian'],
    ['cycling', 'bicycle'],
  ])('should map travelMode %s to %s', async (input, expected) => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: input,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.transportMode).toBe(expected);
  });

  // HERE narrowed `transportMode` overrides base travelMode mapping
  it('should honor narrowed transportMode override (HereMatrixOptions)', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    const options: HereMatrixOptions = {
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: 'driving',
      transportMode: 'truck',
    };
    await connector.matrix(options);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.transportMode).toBe('truck');
  });

  // polling-timeout test: every poll returns 'pending', deadline expires
  it('should throw matrix_polling_timeout with cause.matrixId on deadline expiry', async () => {
    // Submit succeeds, then unlimited pending responses.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/v8/matrix') && !url.includes('/status/')) {
        return Promise.resolve(submitResp('mTimeout'));
      }
      return Promise.resolve(pendingResp());
    });

    let caught: ConnectorError | null = null;
    try {
      await connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
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
    expect(caught?.providerMessage).toContain('mTimeout');
    expect((caught?.cause as { matrixId?: string })?.matrixId).toBe('mTimeout');
    expect((caught?.cause as { statusUrl?: string })?.statusUrl).toBe(
      'https://matrix.router.hereapi.com/v8/status/m1',
    );
  });

  // `timeoutMs` is wrapper-side; never reaches the vendor request body
  it('should strip timeoutMs from the submit body (wrapper-side knob)', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: { body: { timeoutMs: 30_000 } },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.timeoutMs).toBeUndefined();
  });

  // Failed-state test ()
  it('should throw provider_unavailable when status=failed', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'failed', reason: 'computation error' }),
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
    expect(caught?.providerCode).toBe('provider_unavailable');
    expect(caught?.message).toBe('HERE Matrix job failed');
  });

  // mapVendorError mapping table at the submit step
  describe('mapVendorError mapping table (submit phase)', () => {
    it.each<[number, string]>([
      [401, 'auth_failed'],
      [403, 'auth_failed'],
      [429, 'rate_limited'],
      [400, 'invalid_request'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
      [418, 'unknown'],
    ])('HTTP %i maps to providerCode %s', async (status, expectedCode) => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'err' }), { status }),
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

  // Retry-After surface (no structured retryAfterSeconds field per feedback memory)
  it('should surface Retry-After header in providerMessage and cause', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: 'Rate limited', cause: 'Quota exceeded' }),
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
    expect(caught?.providerMessage).toBe(
      'Rate limited: Quota exceeded; retry after 30 seconds',
    );
    expect((caught?.cause as { retryAfter?: string })?.retryAfter).toBe('30');
    // No structured retryAfterSeconds field by design
    expect(
      (caught as unknown as Record<string, unknown>)?.retryAfterSeconds,
    ).toBeUndefined();
  });

  // Poll-phase HTTP error propagates with full mapping
  it('should raise ConnectorError when poll returns non-2xx', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Server error' }), { status: 503 }),
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
    expect(caught?.providerCode).toBe('provider_unavailable');
    expect(caught?.statusCode).toBe(503);
    expect(caught?.message).toContain('HERE Matrix poll');
  });

  // Submit-phase missing matrixId/statusUrl → 'unknown'
  it('should throw unknown when submit response is missing matrixId', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ statusUrl: 'https://example.test/status' }),
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
  });

  // _passthrough merge (mergePassthrough 4-arg form)
  it('should deep-merge _passthrough body and shallow-merge headers', async () => {
    mockFetch
      .mockResolvedValueOnce(submitResp())
      .mockResolvedValueOnce(completedResp())
      .mockResolvedValueOnce(resultResp());

    await connector.matrix({
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      _passthrough: {
        body: { regionDefinition: { margin: 250 } },
        headers: { 'X-Custom': 'val' },
      },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    // deep-merge: connector's regionDefinition.type is preserved, passthrough's
    // margin layered on top
    expect(body.regionDefinition).toEqual({ type: 'autoCircle', margin: 250 });
    expect((init?.headers as Record<string, string>)?.['X-Custom']).toBe('val');
  });

  // Backwards-compat smoke: ConnectorError is thrown on submit failure
  it('should throw ConnectorError on submit 400', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'Bad request' }), { status: 400 }),
    );

    await expect(
      connector.matrix({
        origins: [{ lat: 0, lng: 0 }],
        destinations: [{ lat: 1, lng: 1 }],
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  // LOC-CP-1 (loc-CR #79/#85/#99) — short/sparse flat-array dimension guard
  describe('matrix dimension guard (LOC-CP-1)', () => {
    it('throws ConnectorError when flat arrays are too short for the grid', async () => {
      // 2×2 requested (needs 4 entries) but vendor returned only 3 — pre-fix
      // the missing index silently read `?? 0`; now it must throw.
      mockFetch
        .mockResolvedValueOnce(submitResp())
        .mockResolvedValueOnce(completedResp())
        .mockResolvedValueOnce(
          resultResp({
            numDestinations: 2,
            numOrigins: 2,
            travelTimes: [0, 120, 130],
            distances: [0, 2000, 2100],
          } as {
            numOrigins: number;
            numDestinations: number;
            travelTimes: number[];
            distances: number[];
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

    it('preserves the raw vendor body on cause', async () => {
      const matrix = {
        numOrigins: 2,
        numDestinations: 2,
        travelTimes: [0],
        distances: [0],
      };
      mockFetch
        .mockResolvedValueOnce(submitResp())
        .mockResolvedValueOnce(completedResp())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ matrix }), { status: 200 }),
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
      expect((caught?.cause as { matrix?: unknown })?.matrix).toEqual(matrix);
    });
  });

  // WI-3: validate provider-supplied statusUrl (poll) / resultUrl (retrieve)
  // before ever attaching the API key. A tampered submit response could
  // otherwise exfiltrate apiKey to an arbitrary host.
  describe('async URL validation (assertHereApiUrl, WI-3)', () => {
    async function catchMatrix(): Promise<ConnectorError | null> {
      try {
        await connector.matrix({
          origins: [{ lat: 0, lng: 0 }],
          destinations: [{ lat: 1, lng: 1 }],
        });
      } catch (err) {
        return err as ConnectorError;
      }
      return null;
    }

    // statusUrl (poll) — non-HERE host is rejected before the key is attached
    it('rejects a statusUrl pointing at a non-hereapi host (poll)', async () => {
      mockFetch.mockResolvedValueOnce(submitResp('mBadHost', 'https://evil.example/x'));

      const caught = await catchMatrix();

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('invalid_request');
      expect(caught?.statusCode).toBeNull();
      expect(caught?.message).toContain('statusUrl points to an unexpected host');
      expect((caught?.cause as { url?: string })?.url).toBe('https://evil.example/x');
      // Only the submit call fired — the statusUrl was never fetched.
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    // statusUrl (poll) — non-https scheme is rejected even on a HERE host
    it('rejects a non-https statusUrl (poll)', async () => {
      mockFetch.mockResolvedValueOnce(
        submitResp('mHttp', 'http://matrix.router.hereapi.com/v8/status/mHttp'),
      );

      const caught = await catchMatrix();

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('invalid_request');
      expect(caught?.message).toContain('statusUrl points to an unexpected host');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    // statusUrl (poll) — malformed URL string is rejected as invalid_request
    // rather than surfacing as an uncaught TypeError.
    it('rejects a malformed statusUrl (poll)', async () => {
      mockFetch.mockResolvedValueOnce(submitResp('mBad', 'not a url'));

      const caught = await catchMatrix();

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('invalid_request');
      expect(caught?.message).toContain('statusUrl is not a valid URL');
      expect((caught?.cause as { url?: string })?.url).toBe('not a url');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    // resultUrl (retrieve) — a valid submit + poll(completed) that yields a
    // resultUrl on a non-HERE host is rejected before the key is attached.
    it('rejects a resultUrl pointing at a non-hereapi host (retrieve)', async () => {
      mockFetch
        .mockResolvedValueOnce(submitResp())
        .mockResolvedValueOnce(completedResp('https://evil.example/result'));

      const caught = await catchMatrix();

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('invalid_request');
      expect(caught?.message).toContain('resultUrl points to an unexpected host');
      expect((caught?.cause as { url?: string })?.url).toBe('https://evil.example/result');
      // submit + one poll fired, but the resultUrl was never fetched.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // resultUrl (retrieve) — malformed URL string is rejected as invalid_request.
    it('rejects a malformed resultUrl (retrieve)', async () => {
      mockFetch
        .mockResolvedValueOnce(submitResp())
        .mockResolvedValueOnce(completedResp('::::not a url::::'));

      const caught = await catchMatrix();

      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught?.providerCode).toBe('invalid_request');
      expect(caught?.message).toContain('resultUrl is not a valid URL');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
