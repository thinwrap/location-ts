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
      // Two waypoints = one leg, however many sections HERE split it into.
      expect(result.legs).toEqual([{ distanceMeters: 8000, durationSeconds: 480 }]);
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

  // HERE applies live traffic when `departureTime` is omitted and bills such a
  // request as Time-Aware Routing, so the normalized `trafficMode: 'none'`
  // default has to be spelled out on the wire.
  describe('trafficMode on /v8/routes', () => {
    const TWO_POINTS = [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ];

    async function routesQuery(
      options: Omit<Parameters<HereRoutingConnector['route']>[0], 'waypoints'>,
    ): Promise<URLSearchParams> {
      mockFetch.mockResolvedValueOnce(buildRouteResponse());
      await connector.route({ waypoints: TWO_POINTS, ...options });
      return parseUrlParams(mockFetch.mock.calls[0]![0] as string);
    }

    it('sends departureTime=any and no traffic[mode] by default', async () => {
      const params = await routesQuery({});
      expect(params.getAll('departureTime')).toEqual(['any']);
      expect(params.has('traffic[mode]')).toBe(false);
    });

    it("treats an explicit 'none' the same as the default", async () => {
      const params = await routesQuery({ trafficMode: 'none' });
      expect(params.getAll('departureTime')).toEqual(['any']);
      expect(params.has('traffic[mode]')).toBe(false);
    });

    it('keeps the caller departureTime and disables traffic when not live', async () => {
      const params = await routesQuery({
        departureTime: new Date('2026-09-27T08:30:00Z'),
      });
      expect(params.getAll('departureTime')).toEqual(['2026-09-27T08:30:00.000Z']);
      expect(params.get('traffic[mode]')).toBe('disabled');
    });

    it("sends neither departureTime nor traffic[mode] on 'live' without a time", async () => {
      const params = await routesQuery({ trafficMode: 'live' });
      expect(params.has('departureTime')).toBe(false);
      expect(params.has('traffic[mode]')).toBe(false);
    });

    it("sends only the ISO departureTime on 'live' with a time", async () => {
      const params = await routesQuery({
        trafficMode: 'live',
        departureTime: new Date('2026-09-27T08:30:00Z'),
      });
      expect(params.getAll('departureTime')).toEqual(['2026-09-27T08:30:00.000Z']);
      expect(params.has('traffic[mode]')).toBe(false);
    });

    it('lets _passthrough.query override the traffic defaults', async () => {
      const params = await routesQuery({
        departureTime: new Date('2026-09-27T08:30:00Z'),
        _passthrough: { query: { 'traffic[mode]': 'default' } },
      });
      expect(params.getAll('traffic[mode]')).toEqual(['default']);
      expect(params.getAll('departureTime')).toEqual(['2026-09-27T08:30:00.000Z']);
    });

    // HERE answers `departureTime=any` + `arrivalTime` with HTTP 400.
    it('disables traffic instead of sending any when passthrough sets arrivalTime', async () => {
      const params = await routesQuery({
        _passthrough: { query: { arrivalTime: '2026-09-27T09:00:00Z' } },
      });
      expect(params.has('departureTime')).toBe(false);
      expect(params.getAll('arrivalTime')).toEqual(['2026-09-27T09:00:00Z']);
      expect(params.get('traffic[mode]')).toBe('disabled');
    });

    // Without this, the caller's time would replace `any` and HERE would apply
    // live traffic, billing the request as Time-Aware Routing.
    it('disables traffic when passthrough sets departureTime', async () => {
      const params = await routesQuery({
        _passthrough: { query: { departureTime: '2026-09-27T08:30:00Z' } },
      });
      expect(params.getAll('departureTime')).toEqual(['2026-09-27T08:30:00Z']);
      expect(params.get('traffic[mode]')).toBe('disabled');
    });

    // `disabled` would also drop long-term closures, which `any` keeps.
    it('keeps the default when passthrough sets departureTime=any', async () => {
      const params = await routesQuery({ _passthrough: { query: { departureTime: 'any' } } });
      expect(params.getAll('departureTime')).toEqual(['any']);
      expect(params.has('traffic[mode]')).toBe(false);
    });

    it('applies the default to the /v8/routes call of the optimize flow', async () => {
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
      });
      const sequenceParams = parseUrlParams(mockFetch.mock.calls[0]![0] as string);
      const routesParams = parseUrlParams(mockFetch.mock.calls[1]![0] as string);
      // findsequence2 carries traffic in its `mode` string, not these params.
      expect(sequenceParams.get('mode')).toBe('fastest;car;traffic:disabled');
      expect(sequenceParams.has('departureTime')).toBe(false);
      expect(routesParams.getAll('departureTime')).toEqual(['any']);
      expect(routesParams.has('traffic[mode]')).toBe(false);
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

    describe('departure formatting (legacy WPS grammar)', () => {
      async function emittedDeparture(departureTime: Date): Promise<string | null> {
        mockFetch
          .mockResolvedValueOnce(buildSequenceResponse())
          .mockResolvedValueOnce(buildRouteResponse());
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 2, lng: 2 },
            { lat: 3, lng: 3 },
            { lat: 4, lng: 4 },
          ],
          optimize: true,
          departureTime,
        });
        return parseUrlParams(mockFetch.mock.calls[0]![0] as string).get('departure');
      }

      // Live-verified against findsequence2: `2026-08-07T03:06:00.000Z` answers
      // 400 `Bad Format for Date and Time`, `2026-08-07T03:06:00Z` answers 200.
      // The whole optimized-route path is dead without this.
      it('emits seconds precision with a zone designator, never milliseconds', async () => {
        const departure = await emittedDeparture(new Date('2026-08-07T03:06:00.000Z'));
        expect(departure).toBe('2026-08-07T03:06:00Z');
        expect(departure).not.toContain('.');
        expect(departure).toMatch(/Z$/);
      });

      it('truncates a sub-second departure rather than rounding it into the future', async () => {
        expect(await emittedDeparture(new Date('2026-08-07T03:06:00.999Z'))).toBe(
          '2026-08-07T03:06:00Z',
        );
      });

      it('leaves the /v8/routes leg on the fractional form it accepts', async () => {
        mockFetch.mockResolvedValueOnce(buildRouteResponse());
        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          departureTime: new Date('2026-08-07T03:06:00.000Z'),
        });
        const params = parseUrlParams(mockFetch.mock.calls[0]![0] as string);
        expect(params.get('departureTime')).toBe('2026-08-07T03:06:00.000Z');
      });
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

    it('rejects isRoundTrip with unsupported_option (findsequence2 optimizes an open route, no round trip)', async () => {
      await expect(
        connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
            { lat: 3, lng: 3 },
          ],
          isRoundTrip: true,
        }),
      ).rejects.toMatchObject({ name: 'ConnectorError', providerCode: 'unsupported_option' });
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('sums section length/duration into totals (one leg without a via)', async () => {
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
      expect(result.legs).toEqual([{ distanceMeters: 5555, durationSeconds: 710 }]);
    });
  });

  // HERE v8: a section spans consecutive waypoints "or an implicit change of mode
  // like a ferry section in a driving route" (TransitSection is only used for
  // ferries and car shuttles). `arrival.place.waypoint` is present only for a
  // place that is a request `via` — never for origin/destination or stops the
  // router added — so it, not the section count, delimits legs.
  describe('sections → legs', () => {
    function hereSection(
      type: 'vehicle' | 'transit',
      length: number,
      duration: number,
      arrivalPlace: Record<string, unknown>,
      baseDuration?: number,
    ): Record<string, unknown> {
      return {
        id: `${type}-${length}`,
        type,
        ...(type === 'transit' ? { transport: { mode: 'ferry' } } : { transport: { mode: 'car' } }),
        departure: { place: { type: 'place', location: { lat: 0, lng: 0 } } },
        arrival: { place: { type: 'place', location: { lat: 1, lng: 1 }, ...arrivalPlace } },
        polyline: FLEX_POLYLINE,
        summary: {
          length,
          duration,
          ...(baseDuration !== undefined ? { baseDuration } : {}),
        },
      };
    }

    function respondWith(sections: Array<Record<string, unknown>>): void {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ routes: [{ id: 'r1', sections }] }), { status: 200 }),
      );
    }

    it('2 waypoints with car / ferry / car sections → 1 leg with summed values', async () => {
      respondWith([
        hereSection('vehicle', 12000, 900, {}, 800),
        hereSection('transit', 30000, 3600, {}, 3600),
        hereSection('vehicle', 8000, 600, {}, 500),
      ]);

      const result = await connector.route({
        waypoints: [
          { lat: 54.3, lng: 10.1 },
          { lat: 59.9, lng: 10.7 },
        ],
        include: ['durationWithoutTraffic'],
      });

      expect(result.legs).toEqual([
        { distanceMeters: 50000, durationSeconds: 5100, durationWithoutTrafficSeconds: 4900 },
      ]);
      expect(result.totalDistanceMeters).toBe(50000);
      expect(result.totalDurationSeconds).toBe(5100);
      expect(result.totalDurationWithoutTrafficSeconds).toBe(4900);
      // The polyline still covers every section, ferry included.
      expect(decodePolyline(result.polyline).length).toBeGreaterThan(0);
    });

    it('3 waypoints (1 via) with a ferry in the first half → 2 legs', async () => {
      respondWith([
        hereSection('vehicle', 12000, 900, {}),
        hereSection('transit', 30000, 3600, {}),
        // Arrives at the via: the request's `via` index 0.
        hereSection('vehicle', 5000, 400, { waypoint: 0 }),
        hereSection('vehicle', 7000, 500, {}),
      ]);

      const result = await connector.route({
        waypoints: [
          { lat: 54.3, lng: 10.1 },
          { lat: 57.0, lng: 10.4 },
          { lat: 59.9, lng: 10.7 },
        ],
      });

      expect(result.legs).toEqual([
        { distanceMeters: 47000, durationSeconds: 4900 },
        { distanceMeters: 7000, durationSeconds: 500 },
      ]);
      expect(result.totalDistanceMeters).toBe(54000);
      expect(result.totalDurationSeconds).toBe(5400);
    });

    it('keeps sections 1:1 when none carries a waypoint marker and counts match', async () => {
      respondWith([
        hereSection('vehicle', 1000, 60, {}),
        hereSection('vehicle', 2000, 120, {}),
      ]);

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      });

      expect(result.legs).toEqual([
        { distanceMeters: 1000, durationSeconds: 60 },
        { distanceMeters: 2000, durationSeconds: 120 },
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

    // `bus` and `privateBus` are distinct modes at HERE, not synonyms: `bus`
    // may use bus-exclusive streets, `privateBus` only where a waypoint sits
    // on one — so both are typed, rather than left to `_passthrough.query`.
    it('forwards bus and privateBus to /v8/routes', async () => {
      for (const mode of ['bus', 'privateBus'] as const) {
        mockFetch.mockResolvedValueOnce(buildRouteResponse());

        await connector.route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
          // @ts-expect-error narrowed input not visible through IRoutingOptions
          transportMode: mode,
        });

        const [url] = mockFetch.mock.calls.at(-1)!;
        expect(parseUrlParams(url as string).get('transportMode')).toBe(mode);
      }
    });

    // findsequence2's `mode` grammar accepts `bus` but NOT `privateBus`
    // (verified live: HTTP 400 "Unknown transport mode 'privateBus'"). The
    // connector forwards verbatim rather than silently substituting, so this
    // pins the value that survives the optimization leg.
    it('forwards bus into the findsequence2 mode string', async () => {
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
        transportMode: 'bus',
      });

      const [firstUrl] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(firstUrl as string).get('mode')).toBe(
        'fastest;bus;traffic:disabled',
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

    it('surfaces the legacy WPS `errors[]` message findsequence2 answers with', async () => {
      // findsequence2 does not use the v8 `{ title, cause }` envelope; its reason
      // lives in `errors[]`, and dropping it leaves the caller a bare "failed: 400".
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: null,
            errors: ['Bad Format for Date and Time: 2026-08-07T03:06:00.000Z.'],
            responseCode: '400',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      const thrown = (await connector
        .route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          optimize: true,
        })
        .catch((e) => e)) as ConnectorError;
      expect(thrown.providerMessage).toContain('Bad Format for Date and Time');
    });

    it('surfaces `errors[]` when findsequence2 reports a rejection as HTTP 200', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: null, errors: ['Invalid credentials'], responseCode: '401' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      const thrown = (await connector
        .route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          optimize: true,
        })
        .catch((e) => e)) as ConnectorError;
      expect(thrown.providerMessage).toBe(
        'HERE findsequence2 returned no sequence: Invalid credentials',
      );
    });

    it('maps a findsequence2 failure through mapVendorError when the dispatcher throws it', async () => {
      // End-to-end for the production shape: a host-installed global dispatcher
      // composing `interceptors.responseError()` rejects instead of returning the
      // 400. The caller must still get invalid_request + the HERE message, not
      // provider_unavailable with a null status.
      const rejection = new TypeError('fetch failed');
      (rejection as { cause?: unknown }).cause = {
        name: 'ResponseError',
        code: 'UND_ERR_RESPONSE',
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: {
          results: null,
          errors: ['Bad Format for Date and Time: 2026-08-07T03:06:00.000Z.'],
          responseCode: '400',
        },
      };
      mockFetch.mockRejectedValueOnce(rejection);

      const thrown = (await connector
        .route({
          waypoints: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
            { lat: 2, lng: 2 },
          ],
          optimize: true,
        })
        .catch((e) => e)) as ConnectorError;
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect(thrown.statusCode).toBe(400);
      expect(thrown.providerCode).toBe('invalid_request');
      expect(thrown.providerMessage).toContain('Bad Format for Date and Time');
      expect(JSON.stringify(thrown.cause)).not.toContain(defaultConfig.apiKey);
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

  describe('malformed 200 body normalization', () => {
    // A section without its summary must not be summed as 0 m / 0 s into a
    // plausible leg, and a null route or section must not escape as a TypeError.
    it.each([
      ['a section missing summary', { routes: [{ sections: [{ polyline: '' }] }] }],
      ['a summary missing duration', { routes: [{ sections: [{ summary: { length: 10 } }] }] }],
      ['a null section', { routes: [{ sections: [null] }] }],
      ['a null route', { routes: [null] }],
      ['a route without sections', { routes: [{}] }],
      ['a non-list routes', { routes: 'nope' }],
    ])('raises a ConnectorError for %s', async (_label, body) => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(
        connector.route({
          waypoints: [
            { lat: 52.5, lng: 13.4 },
            { lat: 52.6, lng: 13.5 },
          ],
        }),
      ).rejects.toMatchObject({ name: 'ConnectorError', statusCode: 200 });
    });
  });
});
