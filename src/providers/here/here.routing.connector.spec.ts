import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HereRoutingConnector } from './here.routing.connector';
import type { HereConfig } from './here.config';
import { ConnectorError } from '../../types';
import { decodePolyline, encodePolyline } from '../../utils';
import type { LatLng } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: HereConfig = { apiKey: 'test-here-key' };

// HERE flex-polyline header byte `B` = version 1, precision 5, no third dim.
// This 2-coordinate sample is from the official HERE flex-polyline spec.
const FLEX_POLYLINE = 'BFoz5xJ67i1B1B7PzIhaxL7Y';

function buildRouteResponse(
  overrides: Partial<{
    sections: Array<{ polyline: string; length: number; duration: number }>;
  }> = {},
) {
  const sections = overrides.sections ?? [
    { polyline: FLEX_POLYLINE, length: 5000, duration: 300 },
    { polyline: FLEX_POLYLINE, length: 3000, duration: 180 },
  ];
  return new Response(
    JSON.stringify({
      routes: [
        {
          sections: sections.map((s) => ({
            polyline: s.polyline,
            summary: { length: s.length, duration: s.duration },
          })),
        },
      ],
    }),
    { status: 200 },
  );
}

function buildSequenceResponse(
  overrides: Partial<{
    waypoints: Array<{ id: string; sequence: number }>;
  }> = {},
) {
  const waypoints = overrides.waypoints ?? [
    { id: 'start', sequence: 0 },
    { id: 'destination2', sequence: 1 },
    { id: 'destination1', sequence: 2 },
    { id: 'end', sequence: 3 },
  ];
  return new Response(
    JSON.stringify({
      results: [
        {
          waypoints: waypoints.map((wp) => ({
            id: wp.id,
            lat: 0,
            lng: 0,
            sequence: wp.sequence,
          })),
        },
      ],
    }),
    { status: 200 },
  );
}

function parseUrlParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.substring(q + 1) : '');
}

describe('HereRoutingConnector', () => {
  let connector: HereRoutingConnector;

  beforeEach(() => {
    connector = new HereRoutingConnector(defaultConfig);
  });

  it('should have providerId "here"', () => {
    expect(connector.providerId).toBe('here');
  });

  describe('standard dispatch /v8/routes ', () => {
    it('GETs /v8/routes with apiKey and decodes the polyline', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 52.5308, lng: 13.3847 },
          { lat: 52.5264, lng: 13.3686 },
        ],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(typeof url).toBe('string');
      expect(url as string).toContain('https://router.hereapi.com/v8/routes');
      expect(init?.method).toBe('GET');

      const params = parseUrlParams(url as string);
      expect(params.get('apiKey')).toBe('test-here-key');
      expect(params.get('transportMode')).toBe('car');
      expect(params.get('routingMode')).toBe('fast');
      expect(params.get('return')).toBe('polyline,summary');
      expect(params.get('origin')).toBe('52.5308,13.3847');
      expect(params.get('destination')).toBe('52.5264,13.3686');

      expect(result.totalDistanceMeters).toBe(8000);
      expect(result.totalDurationSeconds).toBe(480);
      expect(result.legs).toHaveLength(2);
      expect(result.legs[0]!.distanceMeters).toBe(5000);
      expect(result.legs[1]!.distanceMeters).toBe(3000);
      expect(typeof result.polyline).toBe('string');
      expect(result.polyline.length).toBeGreaterThan(0);
    });

    it('appends intermediate via= query parameters', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 52.53, lng: 13.38 },
          { lat: 52.52, lng: 13.4 },
          { lat: 52.51, lng: 13.39 },
        ],
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      const viaValues = params.getAll('via');
      expect(viaValues).toEqual(['52.52,13.4']);
    });

    it('emits avoid[features] tokens for avoidTolls/avoidFerries/avoidHighways', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidTolls: true,
        avoidFerries: true,
        avoidHighways: true,
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('avoid[features]')).toBe(
        'tollRoad,ferry,controlledAccessHighway',
      );
    });

    it('emits departureTime ISO string when set', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        departureTime: new Date('2024-01-15T08:00:00Z'),
      });

      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('departureTime')).toBe('2024-01-15T08:00:00.000Z');
    });

    it('maps walking -> pedestrian and cycling -> bicycle', async () => {
      mockFetch
        .mockResolvedValueOnce(buildRouteResponse())
        .mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'walking',
      });
      expect(parseUrlParams(mockFetch.mock.calls[0]![0] as string).get('transportMode')).toBe(
        'pedestrian',
      );

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'cycling',
      });
      expect(parseUrlParams(mockFetch.mock.calls[1]![0] as string).get('transportMode')).toBe(
        'bicycle',
      );
    });
  });

  describe('two-call optimization dispatch ', () => {
    it('calls findsequence2 then /v8/routes when optimize=true with 3+ waypoints', async () => {
      mockFetch
        .mockResolvedValueOnce(buildSequenceResponse())
        .mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
          { lat: 4, lng: 4 },
        ],
        optimize: true,
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [firstUrl] = mockFetch.mock.calls[0]!;
      expect(firstUrl as string).toContain('https://wps.hereapi.com/v8/findsequence2');
      const firstParams = parseUrlParams(firstUrl as string);
      expect(firstParams.get('start')).toBe('0,0');
      expect(firstParams.get('end')).toBe('4,4');
      expect(firstParams.get('mode')).toBe('fastest;car;traffic:disabled');
      // Intermediates serialized as destination1, destination2 (1-indexed).
      expect(firstParams.get('destination1')).toBe('2,2');
      expect(firstParams.get('destination2')).toBe('3,3');

      const [secondUrl] = mockFetch.mock.calls[1]!;
      expect(secondUrl as string).toContain('https://router.hereapi.com/v8/routes');

      // The mock sequence reorders intermediates [2,2] (idx 1) and [3,3] (idx 2)
      // as [3,3] first, then [2,2] -> absolute sequence [0,2,1,3], so the
      // call-2 via params should be in that order.
      const secondParams = parseUrlParams(secondUrl as string);
      const viaValues = secondParams.getAll('via');
      expect(viaValues).toEqual(['3,3', '2,2']);

      // Canonical waypointOrder = full visiting sequence of INPUT indices.
      // findsequence2 reorders the intermediates so the absolute visit order is
      // start(0), destination2(idx 2), destination1(idx 1), end(3) ⇒ [0,2,1,3].
      expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
    });

    it('triggers optimization on optimizeFixedOrigin', async () => {
      mockFetch
        .mockResolvedValueOnce(buildSequenceResponse())
        .mockResolvedValueOnce(buildRouteResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        optimizeFixedOrigin: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0] as string).toContain('findsequence2');
    });

    it('triggers optimization on optimizeFixedDestination', async () => {
      mockFetch
        .mockResolvedValueOnce(buildSequenceResponse())
        .mockResolvedValueOnce(buildRouteResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        optimizeFixedDestination: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0] as string).toContain('findsequence2');
    });

    it('triggers optimization on isRoundTrip', async () => {
      mockFetch
        .mockResolvedValueOnce(buildSequenceResponse())
        .mockResolvedValueOnce(buildRouteResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        isRoundTrip: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0] as string).toContain('findsequence2');
    });

    it('skips optimization when only 2 waypoints (no intermediates)', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());
      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimize: true,
      });
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(result.waypointOrder).toBeUndefined();
    });
  });

  describe('polyline re-encoding ', () => {
    it('decodes HERE flex-polyline and re-encodes as Google precision-5', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      // Result polyline must be a precision-5 Google polyline (not the raw
      // flex). Round-trip back through decodePolyline; the sample flex
      // contains 4 points total (2 sections * 2 each).
      const decoded = decodePolyline(result.polyline);
      expect(decoded.length).toBeGreaterThan(0);

      // The re-encoded polyline must be the precision-5 encoding of the
      // decoded coords (idempotent round-trip).
      expect(result.polyline).toBe(encodePolyline(decoded));
    });

    it('sums section length/duration into totals', async () => {
      mockFetch.mockResolvedValueOnce(
        buildRouteResponse({
          sections: [
            { polyline: FLEX_POLYLINE, length: 1234, duration: 56 },
            { polyline: FLEX_POLYLINE, length: 4321, duration: 654 },
          ],
        }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });

      expect(result.totalDistanceMeters).toBe(5555);
      expect(result.totalDurationSeconds).toBe(710);
      expect(result.legs).toEqual([
        { distanceMeters: 1234, durationSeconds: 56 },
        { distanceMeters: 4321, durationSeconds: 654 },
      ]);
    });
  });

  describe('HereRoutingOptions augmentation ', () => {
    it('uses the narrowed transportMode when provided', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      // Cast through `as any` to mimic a caller using HereRoutingOptions
      // without requiring the spec to type-narrow itself via the facade.
      const opts: Record<string, unknown> = {
        waypoints: [
          { lat: 0, lng: 0 } as LatLng,
          { lat: 1, lng: 1 } as LatLng,
        ],
        transportMode: 'truck',
      };
      await connector.route(opts as never);

      const [url] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(url as string).get('transportMode')).toBe('truck');
    });

    it('narrowed transportMode overrides base travelMode mapping', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'walking',
        // @ts-expect-error narrowed input not visible through IRoutingOptions
        transportMode: 'scooter',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(url as string).get('transportMode')).toBe('scooter');
    });

    it('forwards narrowed transportMode into the findsequence2 mode string', async () => {
      mockFetch
        .mockResolvedValueOnce(buildSequenceResponse())
        .mockResolvedValueOnce(buildRouteResponse());

      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        optimize: true,
        // @ts-expect-error narrowed input not visible through IRoutingOptions
        transportMode: 'truck',
      });

      const [firstUrl] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(firstUrl as string).get('mode')).toBe(
        'fastest;truck;traffic:disabled',
      );
    });
  });

  describe('mapVendorError ', () => {
    const cases: Array<{ status: number; expected: string }> = [
      { status: 400, expected: 'invalid_request' },
      { status: 401, expected: 'auth_failed' },
      { status: 403, expected: 'auth_failed' },
      { status: 429, expected: 'rate_limited' },
      { status: 500, expected: 'provider_unavailable' },
      { status: 503, expected: 'provider_unavailable' },
      { status: 418, expected: 'unknown' },
    ];

    for (const c of cases) {
      it(`HTTP ${c.status} -> ${c.expected}`, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ title: 'Err', cause: 'reason' }), {
            status: c.status,
          }),
        );
        let thrown: unknown;
        try {
          await connector.route({
            waypoints: [
              { lat: 0, lng: 0 },
              { lat: 1, lng: 1 },
            ],
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConnectorError);
        expect((thrown as ConnectorError).providerCode).toBe(c.expected);
        expect((thrown as ConnectorError).statusCode).toBe(c.status);
      });
    }

    it('surfaces Retry-After in providerMessage and cause by design', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Too Many Requests' }), {
          status: 429,
          headers: { 'Retry-After': '42' },
        }),
      );

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerMessage).toContain('retry after 42 seconds');
      expect(thrown!.providerMessage).toContain('Too Many Requests');
      const cause = thrown!.cause as Record<string, unknown> | undefined;
      expect(cause?.retryAfter).toBe('42');
    });

    it('raises ConnectorError when findsequence2 fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: 'Bad request' }), { status: 400 }),
      );
      let thrown: unknown;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          optimize: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
      expect((thrown as ConnectorError).statusCode).toBe(400);
    });
  });

  describe('input validation', () => {
    it('throws invalid_request when fewer than 2 waypoints', async () => {
      let thrown: unknown;
      try {
        await connector.route({ waypoints: [{ lat: 0, lng: 0 }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).providerCode).toBe('invalid_request');
    });
  });

  describe('_passthrough merging', () => {
    it('merges _passthrough.query onto the request URL', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { query: { lang: 'de-DE' } },
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(url as string).get('lang')).toBe('de-DE');
    });

    it('merges _passthrough.headers into the request init', async () => {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { headers: { 'X-Custom': 'value' } },
      });
      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
    });
  });

  // Success-path malformed body: a 200 OK whose JSON fails to parse yields null
  // via `.catch(() => null)` and must surface a typed ConnectorError, not a
  // raw SyntaxError. Two call sites: callRoutes (standard) and callFindSequence
  // (optimize path, first request).
  describe('malformed 200 body', () => {
    it('throws ConnectorError when /v8/routes returns a non-JSON 200 (callRoutes)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('unknown');
      expect(thrown!.message).toBe('HERE Routing returned a malformed response body');
    });

    it('throws ConnectorError when findsequence2 returns a non-JSON 200 (callFindSequence)', async () => {
      // 3 waypoints + optimize → findsequence2 is the FIRST call.
      mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

      let thrown: ConnectorError | undefined;
      try {
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          optimize: true,
        });
      } catch (err) {
        thrown = err as ConnectorError;
      }

      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown!.providerCode).toBe('unknown');
      expect(thrown!.message).toBe('HERE findsequence2 returned a malformed response body');
    });
  });
});
