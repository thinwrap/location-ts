import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorError } from '../types';
import { GoogleRoutingConnector } from './google/google.routing.connector';
import { HereRoutingConnector } from './here/here.routing.connector';
import { MapboxRoutingConnector } from './mapbox/mapbox.routing.connector';
import { OsrmRoutingConnector } from './osrm/osrm.routing.connector';
import { TomTomRoutingConnector } from './tomtom/tomtom.routing.connector';

/**
 * Cross-provider contract for the three 1.2.0 routing inputs.
 *
 * These assert the **request**, not just the result, because all three are
 * cost-bearing: `include` and `trafficMode` change what the vendor bills, and
 * `polylineQuality` changes response size by up to 31x. A spec that only checked
 * the parsed output would let a silent request regression through.
 */

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TWO = [
  { lat: 0, lng: 0 },
  { lat: 1, lng: 1 },
];

function queryOf(callIndex = 0): URLSearchParams {
  const url = mockFetch.mock.calls[callIndex]![0] as string;
  return new URLSearchParams(url.split('?')[1] ?? '');
}

function bodyOf(callIndex = 0): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[callIndex]!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

function headerOf(name: string, callIndex = 0): string | undefined {
  const [, init] = mockFetch.mock.calls[callIndex]!;
  return ((init as RequestInit).headers as Record<string, string>)[name];
}

const GOOGLE_BODY = {
  routes: [
    {
      legs: [{ distanceMeters: 5000, duration: '300s', staticDuration: '280s' }],
      distanceMeters: 5000,
      duration: '300s',
      staticDuration: '280s',
      polyline: { encodedPolyline: 'abc' },
    },
  ],
};

const MAPBOX_BODY = {
  code: 'Ok',
  routes: [
    { geometry: '', legs: [{ distance: 5000, duration: 300 }], distance: 5000, duration: 300 },
  ],
  waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
};

const OSRM_BODY = {
  code: 'Ok',
  routes: [
    { geometry: 'abc', legs: [{ distance: 5000, duration: 300 }], distance: 5000, duration: 300 },
  ],
};

const HERE_BODY = {
  routes: [
    {
      sections: [
        { polyline: 'BGwl_lgDo-6-T', summary: { length: 5000, duration: 300, baseDuration: 280 } },
      ],
    },
  ],
};

const TOMTOM_BODY = {
  routes: [
    {
      summary: {
        lengthInMeters: 5000,
        travelTimeInSeconds: 300,
        noTrafficTravelTimeInSeconds: 280,
      },
      legs: [
        {
          summary: {
            lengthInMeters: 5000,
            travelTimeInSeconds: 300,
            noTrafficTravelTimeInSeconds: 280,
          },
          points: [{ latitude: 0, longitude: 0 }],
        },
      ],
    },
  ],
};

function resp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('polylineQuality', () => {
  it('Google defaults to OVERVIEW and opts up to HIGH_QUALITY', async () => {
    const c = new GoogleRoutingConnector({ apiKey: 'k' });

    mockFetch.mockResolvedValueOnce(resp(GOOGLE_BODY));
    await c.route({ waypoints: TWO });
    expect(bodyOf().polylineQuality).toBe('OVERVIEW');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(resp(GOOGLE_BODY));
    await c.route({ waypoints: TWO, polylineQuality: 'detailed' });
    expect(bodyOf().polylineQuality).toBe('HIGH_QUALITY');
  });

  it.each([
    [undefined, 'simplified'],
    ['simplified' as const, 'simplified'],
    ['detailed' as const, 'full'],
  ])('Mapbox maps %s → overview=%s', async (quality, expected) => {
    mockFetch.mockResolvedValueOnce(resp(MAPBOX_BODY));
    await new MapboxRoutingConnector({ accessToken: 'pk' }).route({
      waypoints: TWO,
      ...(quality !== undefined ? { polylineQuality: quality } : {}),
    });
    expect(queryOf().get('overview')).toBe(expected);
  });

  it.each([
    [undefined, 'simplified'],
    ['simplified' as const, 'simplified'],
    ['detailed' as const, 'full'],
  ])('OSRM maps %s → overview=%s', async (quality, expected) => {
    mockFetch.mockResolvedValueOnce(resp(OSRM_BODY));
    await new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
      waypoints: TWO,
      ...(quality !== undefined ? { polylineQuality: quality } : {}),
    });
    expect(queryOf().get('overview')).toBe(expected);
  });

  // The no-op providers. Silently ignoring is the documented contract — fidelity
  // is cosmetic, so extra vertices cannot make a caller's result wrong. This
  // asserts they neither throw nor invent a vendor parameter.
  it('HERE ignores polylineQuality without throwing or adding a param', async () => {
    mockFetch.mockResolvedValueOnce(resp(HERE_BODY));
    const c = new HereRoutingConnector({ apiKey: 'k' });
    await expect(
      c.route({ waypoints: TWO, polylineQuality: 'detailed' }),
    ).resolves.toBeDefined();
    const q = queryOf();
    expect(q.has('polylineQuality')).toBe(false);
    expect(q.has('overview')).toBe(false);
  });

  it('TomTom ignores polylineQuality without throwing or adding a param', async () => {
    mockFetch.mockResolvedValueOnce(resp(TOMTOM_BODY));
    const c = new TomTomRoutingConnector({ apiKey: 'k' });
    await expect(
      c.route({ waypoints: TWO, polylineQuality: 'detailed' }),
    ).resolves.toBeDefined();
    const q = queryOf();
    expect(q.has('polylineQuality')).toBe(false);
    expect(q.has('overview')).toBe(false);
  });
});

describe('trafficMode', () => {
  it('TomTom sends traffic=false by default and true only on live', async () => {
    const c = new TomTomRoutingConnector({ apiKey: 'k' });

    mockFetch.mockResolvedValueOnce(resp(TOMTOM_BODY));
    await c.route({ waypoints: TWO });
    // Explicit `false`: TomTom's own default is traffic ON, so leaving it unset
    // would contradict the normalized default.
    expect(queryOf().get('traffic')).toBe('false');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(resp(TOMTOM_BODY));
    await c.route({ waypoints: TWO, trafficMode: 'live' });
    expect(queryOf().get('traffic')).toBe('true');
  });

  it('HERE findsequence2 keeps traffic disabled by default (billable)', async () => {
    // Two calls: findsequence2 then /routes.
    mockFetch
      .mockResolvedValueOnce(
        resp({
          results: [
            {
              waypoints: [
                { id: 'start', sequence: 0 },
                { id: 'destination1', sequence: 1 },
                { id: 'end', sequence: 2 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(resp(HERE_BODY));

    await new HereRoutingConnector({ apiKey: 'k' }).route({
      waypoints: [...TWO, { lat: 2, lng: 2 }],
      optimize: true,
    });

    expect(queryOf(0).get('mode')).toBe('fastest;car;traffic:disabled');
  });

  it('HERE findsequence2 enables traffic on trafficMode live', async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          results: [
            {
              waypoints: [
                { id: 'start', sequence: 0 },
                { id: 'destination1', sequence: 1 },
                { id: 'end', sequence: 2 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(resp(HERE_BODY));

    await new HereRoutingConnector({ apiKey: 'k' }).route({
      waypoints: [...TWO, { lat: 2, lng: 2 }],
      optimize: true,
      trafficMode: 'live',
    });

    expect(queryOf(0).get('mode')).toBe('fastest;car;traffic:enabled');
  });

  // L7's free half: the toll modifier costs nothing, so it applies whether or
  // not traffic was opted into. Before this, the optimizer ordered waypoints as
  // if tolls were acceptable while the follow-up /routes call avoided them, so
  // the ordering and the route disagreed.
  it('HERE findsequence2 applies the toll modifier unconditionally', async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          results: [
            {
              waypoints: [
                { id: 'start', sequence: 0 },
                { id: 'destination1', sequence: 1 },
                { id: 'end', sequence: 2 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(resp(HERE_BODY));

    await new HereRoutingConnector({ apiKey: 'k' }).route({
      waypoints: [...TWO, { lat: 2, lng: 2 }],
      optimize: true,
      avoidTolls: true,
    });

    // `-3` (strictly avoid), and traffic still disabled — the free half applies
    // without dragging in the billable half.
    expect(queryOf(0).get('mode')).toBe('fastest;car;traffic:disabled;tollroad:-3');
  });

  it('HERE omits the toll modifier when avoidTolls is not set', async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          results: [
            {
              waypoints: [
                { id: 'start', sequence: 0 },
                { id: 'destination1', sequence: 1 },
                { id: 'end', sequence: 2 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(resp(HERE_BODY));

    await new HereRoutingConnector({ apiKey: 'k' }).route({
      waypoints: [...TWO, { lat: 2, lng: 2 }],
      optimize: true,
    });

    expect(queryOf(0).get('mode')).not.toContain('tollroad');
  });
});

describe('include: durationWithoutTraffic', () => {
  it('Google omits staticDuration from the field mask by default', async () => {
    mockFetch.mockResolvedValueOnce(resp(GOOGLE_BODY));
    const result = await new GoogleRoutingConnector({ apiKey: 'k' }).route({
      waypoints: TWO,
    });

    const mask = headerOf('X-Goog-FieldMask')!;
    expect(mask).not.toContain('staticDuration');
    // Not surfaced even though this fixture happens to carry it — the field
    // follows the opt-in, not the response.
    expect(result.legs[0]!.durationWithoutTrafficSeconds).toBeUndefined();
    expect(result.totalDurationWithoutTrafficSeconds).toBeUndefined();
  });

  it('Google requests and surfaces staticDuration when included', async () => {
    mockFetch.mockResolvedValueOnce(resp(GOOGLE_BODY));
    const result = await new GoogleRoutingConnector({ apiKey: 'k' }).route({
      waypoints: TWO,
      include: ['durationWithoutTraffic'],
    });

    const mask = headerOf('X-Goog-FieldMask')!;
    expect(mask).toContain('routes.legs.staticDuration');
    expect(mask).toContain('routes.staticDuration');
    expect(result.legs[0]!.durationWithoutTrafficSeconds).toBe(280);
    expect(result.totalDurationWithoutTrafficSeconds).toBe(280);
  });

  it('TomTom omits computeTravelTimeFor by default and sends it when included', async () => {
    const c = new TomTomRoutingConnector({ apiKey: 'k' });

    mockFetch.mockResolvedValueOnce(resp(TOMTOM_BODY));
    const plain = await c.route({ waypoints: TWO });
    expect(queryOf().has('computeTravelTimeFor')).toBe(false);
    expect(plain.legs[0]!.durationWithoutTrafficSeconds).toBeUndefined();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(resp(TOMTOM_BODY));
    const included = await c.route({
      waypoints: TWO,
      include: ['durationWithoutTraffic'],
    });
    expect(queryOf().get('computeTravelTimeFor')).toBe('all');
    expect(included.legs[0]!.durationWithoutTrafficSeconds).toBe(280);
    expect(included.totalDurationWithoutTrafficSeconds).toBe(280);
  });

  it('HERE surfaces baseDuration only when included (no extra request param)', async () => {
    const c = new HereRoutingConnector({ apiKey: 'k' });

    mockFetch.mockResolvedValueOnce(resp(HERE_BODY));
    const plain = await c.route({ waypoints: TWO });
    expect(plain.legs[0]!.durationWithoutTrafficSeconds).toBeUndefined();
    // HERE ships baseDuration inside the `summary` block already requested, so
    // opting in changes no request parameter.
    expect(queryOf().get('return')).toBe('polyline,summary');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(resp(HERE_BODY));
    const included = await c.route({
      waypoints: TWO,
      include: ['durationWithoutTraffic'],
    });
    expect(included.legs[0]!.durationWithoutTrafficSeconds).toBe(280);
    expect(included.totalDurationWithoutTrafficSeconds).toBe(280);
    expect(queryOf().get('return')).toBe('polyline,summary');
  });

  // The never-synthesized rule: if the provider does not return the value, the
  // field stays absent even though the token was passed. Absence is information.
  it.each([
    [
      'Mapbox',
      () =>
        new MapboxRoutingConnector({ accessToken: 'pk' }).route({
          waypoints: TWO,
          include: ['durationWithoutTraffic'],
        }),
      MAPBOX_BODY,
    ],
    [
      'OSRM',
      () =>
        new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
          waypoints: TWO,
          include: ['durationWithoutTraffic'],
        }),
      OSRM_BODY,
    ],
  ])('%s leaves the field absent rather than synthesizing it', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const result = await run();
    expect(result.legs[0]!.durationWithoutTrafficSeconds).toBeUndefined();
    expect(result.totalDurationWithoutTrafficSeconds).toBeUndefined();
    // The traffic-aware duration is still there — only the optional extra is not.
    expect(result.legs[0]!.durationSeconds).toBe(300);
  });

  it('Google leaves the field absent when the vendor omits it despite the opt-in', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        routes: [
          {
            legs: [{ distanceMeters: 5000, duration: '300s' }],
            distanceMeters: 5000,
            duration: '300s',
            polyline: { encodedPolyline: 'abc' },
          },
        ],
      }),
    );
    const result = await new GoogleRoutingConnector({ apiKey: 'k' }).route({
      waypoints: TWO,
      include: ['durationWithoutTraffic'],
    });
    expect(result.legs[0]!.durationWithoutTrafficSeconds).toBeUndefined();
    expect(result.totalDurationWithoutTrafficSeconds).toBeUndefined();
  });

  it('HERE omits the total when only some sections carry baseDuration', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        routes: [
          {
            sections: [
              { polyline: 'BGwl_lgDo-6-T', summary: { length: 100, duration: 10, baseDuration: 9 } },
              { polyline: 'BGwl_lgDo-6-T', summary: { length: 100, duration: 10 } },
            ],
          },
        ],
      }),
    );
    const result = await new HereRoutingConnector({ apiKey: 'k' }).route({
      waypoints: TWO,
      include: ['durationWithoutTraffic'],
    });
    // Under-reporting a total is worse than omitting it.
    expect(result.totalDurationWithoutTrafficSeconds).toBeUndefined();
    expect(result.legs[0]!.durationWithoutTrafficSeconds).toBe(9);
    expect(result.legs[1]!.durationWithoutTrafficSeconds).toBeUndefined();
  });
});

describe('OsrmConfig.supportedExcludeClasses', () => {
  it.each([
    ['avoidTolls', 'toll'],
    ['avoidFerries', 'ferry'],
    ['avoidHighways', 'motorway'],
  ])('rejects %s when the build does not declare %s', async (flag, excludeClass) => {
    const c = new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' });
    try {
      await c.route({ waypoints: TWO, [flag]: true });
      expect.fail('expected throw');
    } catch (err) {
      const ce = err as ConnectorError;
      expect(ce.providerCode).toBe('unsupported_option');
      expect(ce.statusCode).toBeNull();
      expect(ce.providerMessage).toContain(excludeClass);
      expect(ce.providerMessage).toContain('supportedExcludeClasses');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends exclude= for a declared class', async () => {
    mockFetch.mockResolvedValueOnce(resp(OSRM_BODY));
    await new OsrmRoutingConnector({
      baseUrl: 'http://localhost:5000',
      supportedExcludeClasses: ['toll'],
    }).route({ waypoints: TWO, avoidTolls: true });

    expect(queryOf().get('exclude')).toBe('toll');
  });

  it('comma-joins several declared classes', async () => {
    mockFetch.mockResolvedValueOnce(resp(OSRM_BODY));
    await new OsrmRoutingConnector({
      baseUrl: 'http://localhost:5000',
      supportedExcludeClasses: ['toll', 'ferry', 'motorway'],
    }).route({
      waypoints: TWO,
      avoidTolls: true,
      avoidFerries: true,
      avoidHighways: true,
    });

    expect(queryOf().get('exclude')).toBe('toll,ferry,motorway');
  });

  it('still rejects a flag whose class is not among those declared', async () => {
    const c = new OsrmRoutingConnector({
      baseUrl: 'http://localhost:5000',
      supportedExcludeClasses: ['ferry'],
    });
    await expect(c.route({ waypoints: TWO, avoidTolls: true })).rejects.toMatchObject({
      providerCode: 'unsupported_option',
    });
  });

  it('omits exclude= entirely when no avoid flag is set', async () => {
    mockFetch.mockResolvedValueOnce(resp(OSRM_BODY));
    await new OsrmRoutingConnector({
      baseUrl: 'http://localhost:5000',
      supportedExcludeClasses: ['toll'],
    }).route({ waypoints: TWO });

    expect(queryOf().has('exclude')).toBe(false);
  });
});

describe('route responses with no legs', () => {
  it.each([
    [
      'Mapbox',
      () => new MapboxRoutingConnector({ accessToken: 'pk' }).route({ waypoints: TWO }),
      {
        code: 'Ok',
        routes: [{ geometry: '', legs: [], distance: 5000, duration: 300 }],
        waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
      },
    ],
    [
      'OSRM',
      () =>
        new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
          waypoints: TWO,
        }),
      { code: 'Ok', routes: [{ geometry: 'abc', legs: [], distance: 5000, duration: 300 }] },
    ],
  ])('%s raises no_route rather than returning a legless route', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const ce = await run().then(
      () => {
        throw new Error('expected a ConnectorError');
      },
      (err: unknown) => err as ConnectorError,
    );
    expect(ce).toBeInstanceOf(ConnectorError);
    expect(ce.providerCode).toBe('no_route');
    // Totals looked plausible; there was simply nothing to iterate.
    expect(ce.providerMessage).toContain('no legs');
  });
});
