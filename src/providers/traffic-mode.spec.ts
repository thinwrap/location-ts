import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IMatrixOptions, IRoutingOptions, TrafficMode } from '../types';
import { isTrafficRequested } from '../utils/traffic';
import { EsriMatrixConnector } from './esri/esri.matrix.connector';
import { EsriRoutingConnector } from './esri/esri.routing.connector';
import { GoogleMatrixConnector } from './google/google.matrix.connector';
import { GoogleRoutingConnector } from './google/google.routing.connector';
import { HereMatrixConnector } from './here/here.matrix.connector';
import { HereRoutingConnector } from './here/here.routing.connector';
import { MapboxMatrixConnector } from './mapbox/mapbox.matrix.connector';
import { MapboxRoutingConnector } from './mapbox/mapbox.routing.connector';
import { OsrmMatrixConnector } from './osrm/osrm.matrix.connector';
import { OsrmRoutingConnector } from './osrm/osrm.routing.connector';
import { TomTomMatrixConnector } from './tomtom/tomtom.matrix.connector';
import { TomTomRoutingConnector } from './tomtom/tomtom.routing.connector';

/**
 * Cross-provider contract for `trafficMode` × `departureTime`.
 *
 * Asserts the exact wire parameters, because both inputs are cost-bearing
 * (Google Pro SKU, HERE Time-Aware Routing) and because `'none'` promises
 * time-independent durations: a departure time that slipped through as a
 * traffic input would change the numbers without any error.
 *
 * Only the request matters here, so every vendor call answers HTTP 400 and the
 * resulting error is swallowed; `expect(mockFetch).toHaveBeenCalled()` keeps a
 * pre-flight throw from passing as a request.
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
const ORIGINS = [{ lat: 0, lng: 0 }];
const DESTINATIONS = [{ lat: 1, lng: 1 }];

// Sub-second on purpose: Mapbox `depart_at` and HERE findsequence2 `departure`
// take seconds precision, everything else the full `toISOString()`.
const T = new Date('2026-09-28T21:30:00.750Z');
const T_ISO = '2026-09-28T21:30:00.750Z';
const T_ISO_SECONDS = '2026-09-28T21:30:00Z';
const T_EPOCH_MS = String(T.getTime());

const NO_TRAFFIC: (TrafficMode | undefined)[] = [undefined, 'none'];
const TRAFFIC: TrafficMode[] = ['traffic', 'live'];

async function capture(run: () => Promise<unknown>): Promise<void> {
  mockFetch.mockResolvedValue(new Response('{}', { status: 400 }));
  await run().catch(() => undefined);
  expect(mockFetch).toHaveBeenCalled();
}

function urlOf(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex]![0] as string;
}

function queryOf(callIndex = 0): URLSearchParams {
  return new URLSearchParams(urlOf(callIndex).split('?')[1] ?? '');
}

function rawBodyOf(callIndex = 0): string {
  return (mockFetch.mock.calls[callIndex]![1] as RequestInit).body as string;
}

function jsonBodyOf(callIndex = 0): Record<string, unknown> {
  return JSON.parse(rawBodyOf(callIndex)) as Record<string, unknown>;
}

function formOf(callIndex = 0): URLSearchParams {
  return new URLSearchParams(rawBodyOf(callIndex));
}

const google = () => new GoogleRoutingConnector({ apiKey: 'k' });
const googleMatrix = () => new GoogleMatrixConnector({ apiKey: 'k' });
const here = () => new HereRoutingConnector({ apiKey: 'k' });
const hereMatrix = () => new HereMatrixConnector({ apiKey: 'k' });
const esri = () => new EsriRoutingConnector({ apiKey: 'k' });
const esriMatrix = () => new EsriMatrixConnector({ apiKey: 'k' });
const mapbox = () => new MapboxRoutingConnector({ accessToken: 'pk.k' });
const mapboxMatrix = () => new MapboxMatrixConnector({ accessToken: 'pk.k' });
const tomtom = () => new TomTomRoutingConnector({ apiKey: 'k' });
const tomtomMatrix = () => new TomTomMatrixConnector({ apiKey: 'k' });

describe('isTrafficRequested', () => {
  it('treats "traffic" and its deprecated alias "live" as traffic, anything else as none', () => {
    expect(isTrafficRequested('traffic')).toBe(true);
    expect(isTrafficRequested('live')).toBe(true);
    expect(isTrafficRequested('none')).toBe(false);
    expect(isTrafficRequested(undefined)).toBe(false);
  });
});

describe('Google Routes: routingPreference + departureTime', () => {
  for (const [name, run] of [
    ['routes', (o: Partial<IRoutingOptions>) => google().route({ waypoints: TWO, ...o })],
    [
      'matrix',
      (o: Partial<IMatrixOptions>) =>
        googleMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, ...o }),
    ],
  ] as const) {
    for (const trafficMode of NO_TRAFFIC) {
      // The live-verified 400: "Timestamp cannot be set for TRAFFIC_UNAWARE
      // routing mode." — so the time must not be sent under 'none'.
      it(`${name}: ${String(trafficMode)} + time → TRAFFIC_UNAWARE, no departureTime`, async () => {
        await capture(() => run({ trafficMode, departureTime: T }));
        expect(jsonBodyOf().routingPreference).toBe('TRAFFIC_UNAWARE');
        expect(jsonBodyOf()).not.toHaveProperty('departureTime');
      });

      it(`${name}: ${String(trafficMode)}, no time → TRAFFIC_UNAWARE, no departureTime`, async () => {
        await capture(() => run({ trafficMode }));
        expect(jsonBodyOf().routingPreference).toBe('TRAFFIC_UNAWARE');
        expect(jsonBodyOf()).not.toHaveProperty('departureTime');
      });
    }

    for (const trafficMode of TRAFFIC) {
      it(`${name}: ${trafficMode} + time → TRAFFIC_AWARE + departureTime`, async () => {
        await capture(() => run({ trafficMode, departureTime: T }));
        expect(jsonBodyOf().routingPreference).toBe('TRAFFIC_AWARE');
        expect(jsonBodyOf().departureTime).toBe(T_ISO);
      });

      it(`${name}: ${trafficMode}, no time → TRAFFIC_AWARE, no departureTime`, async () => {
        await capture(() => run({ trafficMode }));
        expect(jsonBodyOf().routingPreference).toBe('TRAFFIC_AWARE');
        expect(jsonBodyOf()).not.toHaveProperty('departureTime');
      });
    }
  }

  it('routes: walking + traffic + time keeps the time and sends no routingPreference', async () => {
    await capture(() =>
      google().route({ waypoints: TWO, travelMode: 'walking', trafficMode: 'traffic', departureTime: T }),
    );
    expect(jsonBodyOf()).not.toHaveProperty('routingPreference');
    expect(jsonBodyOf().departureTime).toBe(T_ISO);
  });
});

describe('HERE /v8/routes + /v8/matrix: departureTime / traffic[mode]', () => {
  for (const trafficMode of NO_TRAFFIC) {
    it(`routes: ${String(trafficMode)}, no time → departureTime=any`, async () => {
      await capture(() => here().route({ waypoints: TWO, trafficMode }));
      expect(queryOf().get('departureTime')).toBe('any');
      expect(queryOf().has('traffic[mode]')).toBe(false);
    });

    it(`routes: ${String(trafficMode)} + time → the time + traffic[mode]=disabled`, async () => {
      await capture(() => here().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(queryOf().get('departureTime')).toBe(T_ISO);
      expect(queryOf().get('traffic[mode]')).toBe('disabled');
    });

    it(`matrix: ${String(trafficMode)}, no time → departureTime "any"`, async () => {
      await capture(() =>
        hereMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode }),
      );
      expect(jsonBodyOf().departureTime).toBe('any');
      expect(jsonBodyOf()).not.toHaveProperty('traffic');
    });

    it(`matrix: ${String(trafficMode)} + time → the time + traffic.mode "disabled"`, async () => {
      await capture(() =>
        hereMatrix().matrix({
          origins: ORIGINS,
          destinations: DESTINATIONS,
          trafficMode,
          departureTime: T,
        }),
      );
      expect(jsonBodyOf().departureTime).toBe(T_ISO);
      expect(jsonBodyOf().traffic).toEqual({ mode: 'disabled' });
    });
  }

  for (const trafficMode of TRAFFIC) {
    it(`routes: ${trafficMode}, no time → HERE's default (nothing sent)`, async () => {
      await capture(() => here().route({ waypoints: TWO, trafficMode }));
      expect(queryOf().has('departureTime')).toBe(false);
      expect(queryOf().has('traffic[mode]')).toBe(false);
    });

    it(`routes: ${trafficMode} + time → the time only`, async () => {
      await capture(() => here().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(queryOf().get('departureTime')).toBe(T_ISO);
      expect(queryOf().has('traffic[mode]')).toBe(false);
    });

    it(`matrix: ${trafficMode}, no time → nothing sent`, async () => {
      await capture(() =>
        hereMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode }),
      );
      expect(jsonBodyOf()).not.toHaveProperty('departureTime');
      expect(jsonBodyOf()).not.toHaveProperty('traffic');
    });

    it(`matrix: ${trafficMode} + time → the time only`, async () => {
      await capture(() =>
        hereMatrix().matrix({
          origins: ORIGINS,
          destinations: DESTINATIONS,
          trafficMode,
          departureTime: T,
        }),
      );
      expect(jsonBodyOf().departureTime).toBe(T_ISO);
      expect(jsonBodyOf()).not.toHaveProperty('traffic');
    });
  }

  it('routes: a passthrough departureTime still wins over the connector default', async () => {
    await capture(() =>
      here().route({
        waypoints: TWO,
        trafficMode: 'none',
        departureTime: T,
        _passthrough: { query: { 'traffic[mode]': 'default' } },
      }),
    );
    expect(queryOf().get('traffic[mode]')).toBe('default');
  });

  describe('findsequence2 (optimize)', () => {
    const SEQUENCE = {
      results: [
        {
          waypoints: [
            { id: 'start', sequence: 0 },
            { id: 'destination1', sequence: 1 },
            { id: 'end', sequence: 2 },
          ],
        },
      ],
    };

    for (const trafficMode of [...NO_TRAFFIC, ...TRAFFIC]) {
      const expected = isTrafficRequested(trafficMode) ? 'enabled' : 'disabled';
      it(`${String(trafficMode)} + time → traffic:${expected} + departure (seconds)`, async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(SEQUENCE), { status: 200 }));
        await capture(() =>
          here().route({
            waypoints: [...TWO, { lat: 2, lng: 2 }],
            optimize: true,
            trafficMode,
            departureTime: T,
          }),
        );
        expect(queryOf(0).get('mode')).toBe(`fastest;car;traffic:${expected}`);
        expect(queryOf(0).get('departure')).toBe(T_ISO_SECONDS);
      });
    }
  });
});

describe('Esri: startTime (routing) / timeOfDay (matrix)', () => {
  for (const [name, run, key] of [
    [
      'routing',
      (o: Partial<IRoutingOptions>) => esri().route({ waypoints: TWO, ...o }),
      'startTime',
    ],
    [
      'matrix',
      (o: Partial<IMatrixOptions>) =>
        esriMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, ...o }),
      'timeOfDay',
    ],
  ] as const) {
    const isUtc = `${key}IsUTC`;

    for (const trafficMode of NO_TRAFFIC) {
      // A time is Esri's traffic switch: with one it applies typical or live
      // traffic, without one time-independent speeds.
      it(`${name}: ${String(trafficMode)} + time → no ${key} (the time is dropped)`, async () => {
        await capture(() => run({ trafficMode, departureTime: T }));
        expect(formOf().has(key)).toBe(false);
        expect(formOf().has(isUtc)).toBe(false);
      });

      it(`${name}: ${String(trafficMode)}, no time → no ${key}`, async () => {
        await capture(() => run({ trafficMode }));
        expect(formOf().has(key)).toBe(false);
        expect(formOf().has(isUtc)).toBe(false);
      });

      it(`${name}: ${String(trafficMode)} → a passthrough ${key} still wins`, async () => {
        await capture(() =>
          run({ trafficMode, departureTime: T, _passthrough: { body: { [key]: 'now' } } }),
        );
        expect(formOf().get(key)).toBe('now');
      });
    }

    for (const trafficMode of TRAFFIC) {
      it(`${name}: ${trafficMode}, no time → ${key}=now`, async () => {
        await capture(() => run({ trafficMode }));
        expect(formOf().get(key)).toBe('now');
        expect(formOf().get(isUtc)).toBe('true');
      });

      it(`${name}: ${trafficMode} + time → epoch ms + ${isUtc}=true`, async () => {
        await capture(() => run({ trafficMode, departureTime: T }));
        expect(formOf().get(key)).toBe(T_EPOCH_MS);
        expect(formOf().get(isUtc)).toBe('true');
      });

      it(`${name}: ${trafficMode} → a passthrough ${key} still wins`, async () => {
        await capture(() =>
          run({ trafficMode, departureTime: T, _passthrough: { body: { [key]: '1' } } }),
        );
        expect(formOf().get(key)).toBe('1');
      });
    }

    it(`${name}: an invalid departureTime is rejected even under 'none'`, async () => {
      await expect(
        run({ trafficMode: 'none', departureTime: new Date(Number.NaN) }),
      ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  }
});

describe('Mapbox Directions: profile + depart_at', () => {
  const profileOf = () => urlOf().split('?')[0]!.split('/')[6];

  for (const trafficMode of NO_TRAFFIC) {
    it(`${String(trafficMode)} + time → driving, no depart_at`, async () => {
      await capture(() => mapbox().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(profileOf()).toBe('driving');
      expect(queryOf().has('depart_at')).toBe(false);
    });

    it(`${String(trafficMode)}, no time → driving, no depart_at`, async () => {
      await capture(() => mapbox().route({ waypoints: TWO, trafficMode }));
      expect(profileOf()).toBe('driving');
      expect(queryOf().has('depart_at')).toBe(false);
    });
  }

  for (const trafficMode of TRAFFIC) {
    it(`${trafficMode} + time → driving-traffic + depart_at (seconds)`, async () => {
      await capture(() => mapbox().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(profileOf()).toBe('driving-traffic');
      expect(queryOf().get('depart_at')).toBe(T_ISO_SECONDS);
    });

    it(`${trafficMode}, no time → driving-traffic, no depart_at`, async () => {
      await capture(() => mapbox().route({ waypoints: TWO, trafficMode }));
      expect(profileOf()).toBe('driving-traffic');
      expect(queryOf().has('depart_at')).toBe(false);
    });

    for (const travelMode of ['walking', 'cycling'] as const) {
      it(`${trafficMode} is ignored on ${travelMode}: no traffic profile, no depart_at`, async () => {
        await capture(() =>
          mapbox().route({ waypoints: TWO, travelMode, trafficMode, departureTime: T }),
        );
        expect(profileOf()).toBe(travelMode);
        expect(queryOf().has('depart_at')).toBe(false);
      });
    }
  }

  it('a passthrough depart_at still wins under none', async () => {
    await capture(() =>
      mapbox().route({
        waypoints: TWO,
        trafficMode: 'none',
        departureTime: T,
        _passthrough: { query: { depart_at: '2026-10-01T08:00' } },
      }),
    );
    expect(queryOf().get('depart_at')).toBe('2026-10-01T08:00');
  });
});

describe('Mapbox Optimization: traffic ignored, time only rejected with traffic on driving', () => {
  const THREE = [...TWO, { lat: 2, lng: 2 }];
  const profileOf = () => urlOf().split('?')[0]!.split('/')[6];

  for (const trafficMode of NO_TRAFFIC) {
    it(`${String(trafficMode)} + time → the time is dropped, no error`, async () => {
      await capture(() =>
        mapbox().route({ waypoints: THREE, optimize: true, trafficMode, departureTime: T }),
      );
      expect(urlOf()).toContain('/optimized-trips/v1/mapbox/driving/');
      expect(queryOf().has('depart_at')).toBe(false);
    });
  }

  for (const trafficMode of TRAFFIC) {
    it(`${trafficMode}, no time → silently the driving profile (no traffic profile exists)`, async () => {
      await capture(() => mapbox().route({ waypoints: THREE, optimize: true, trafficMode }));
      expect(profileOf()).toBe('driving');
    });

    for (const travelMode of [undefined, 'driving'] as const) {
      it(`${trafficMode} + time on ${String(travelMode)} → unsupported_field before any request`, async () => {
        await expect(
          mapbox().route({ waypoints: THREE, optimize: true, travelMode, trafficMode, departureTime: T }),
        ).rejects.toMatchObject({ providerCode: 'unsupported_field', statusCode: null });
        expect(mockFetch).not.toHaveBeenCalled();
      });
    }

    // No traffic model on walking/cycling, so traffic means nothing there and
    // the time is dropped exactly as under 'none'.
    for (const travelMode of ['walking', 'cycling'] as const) {
      it(`${trafficMode} + time on ${travelMode} → the time is dropped, no error`, async () => {
        await capture(() =>
          mapbox().route({ waypoints: THREE, optimize: true, travelMode, trafficMode, departureTime: T }),
        );
        expect(profileOf()).toBe(travelMode);
        expect(queryOf().has('depart_at')).toBe(false);
      });
    }
  }
});

describe('Mapbox Matrix: profile, time only rejected with traffic on driving', () => {
  const profileOf = () => urlOf().split('?')[0]!.split('/')[6];

  for (const trafficMode of NO_TRAFFIC) {
    it(`${String(trafficMode)} + time → driving, the time is dropped (no error)`, async () => {
      await capture(() =>
        mapboxMatrix().matrix({
          origins: ORIGINS,
          destinations: DESTINATIONS,
          trafficMode,
          departureTime: T,
        }),
      );
      expect(profileOf()).toBe('driving');
      expect(queryOf().has('depart_at')).toBe(false);
    });
  }

  for (const trafficMode of TRAFFIC) {
    it(`${trafficMode}, no time → driving-traffic`, async () => {
      await capture(() =>
        mapboxMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode }),
      );
      expect(profileOf()).toBe('driving-traffic');
      expect(queryOf().has('depart_at')).toBe(false);
    });

    for (const travelMode of [undefined, 'driving'] as const) {
      it(`${trafficMode} + time on ${String(travelMode)} → unsupported_field before any request`, async () => {
        await expect(
          mapboxMatrix().matrix({
            origins: ORIGINS,
            destinations: DESTINATIONS,
            travelMode,
            trafficMode,
            departureTime: T,
          }),
        ).rejects.toMatchObject({ providerCode: 'unsupported_field', statusCode: null });
        expect(mockFetch).not.toHaveBeenCalled();
      });
    }

    for (const travelMode of ['walking', 'cycling'] as const) {
      it(`${trafficMode} + time on ${travelMode} → ${travelMode}, the time is dropped (no error)`, async () => {
        await capture(() =>
          mapboxMatrix().matrix({
            origins: ORIGINS,
            destinations: DESTINATIONS,
            travelMode,
            trafficMode,
            departureTime: T,
          }),
        );
        expect(profileOf()).toBe(travelMode);
        expect(queryOf().has('depart_at')).toBe(false);
      });
    }
  }
});

describe('TomTom Calculate Route: traffic + departAt', () => {
  for (const trafficMode of NO_TRAFFIC) {
    // No time-independent mode exists (departAt=any is rejected), so the time
    // is kept and TomTom's typical traffic for it still applies — documented.
    it(`${String(trafficMode)} + time → traffic=false + departAt`, async () => {
      await capture(() => tomtom().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(queryOf().get('traffic')).toBe('false');
      expect(queryOf().get('departAt')).toBe(T_ISO);
    });

    it(`${String(trafficMode)}, no time → traffic=false, no departAt`, async () => {
      await capture(() => tomtom().route({ waypoints: TWO, trafficMode }));
      expect(queryOf().get('traffic')).toBe('false');
      expect(queryOf().has('departAt')).toBe(false);
    });
  }

  for (const trafficMode of TRAFFIC) {
    it(`${trafficMode} + time → traffic=true + departAt`, async () => {
      await capture(() => tomtom().route({ waypoints: TWO, trafficMode, departureTime: T }));
      expect(queryOf().get('traffic')).toBe('true');
      expect(queryOf().get('departAt')).toBe(T_ISO);
    });

    it(`${trafficMode}, no time → traffic=true, no departAt`, async () => {
      await capture(() => tomtom().route({ waypoints: TWO, trafficMode }));
      expect(queryOf().get('traffic')).toBe('true');
      expect(queryOf().has('departAt')).toBe(false);
    });
  }
});

describe('TomTom Matrix: options.traffic + options.departAt', () => {
  const optionsOf = () => jsonBodyOf().options as Record<string, unknown>;

  for (const trafficMode of NO_TRAFFIC) {
    for (const departureTime of [undefined, T]) {
      it(`${String(trafficMode)} ${departureTime ? '+ time' : ', no time'} → historical + departAt any`, async () => {
        await capture(() =>
          tomtomMatrix().matrix({
            origins: ORIGINS,
            destinations: DESTINATIONS,
            trafficMode,
            departureTime,
          }),
        );
        expect(optionsOf().traffic).toBe('historical');
        expect(optionsOf().departAt).toBe('any');
      });
    }
  }

  for (const trafficMode of TRAFFIC) {
    it(`${trafficMode}, no time → live + departAt now`, async () => {
      await capture(() =>
        tomtomMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode }),
      );
      expect(optionsOf().traffic).toBe('live');
      expect(optionsOf().departAt).toBe('now');
    });

    it(`${trafficMode} + time → live + departAt`, async () => {
      await capture(() =>
        tomtomMatrix().matrix({
          origins: ORIGINS,
          destinations: DESTINATIONS,
          trafficMode,
          departureTime: T,
        }),
      );
      expect(optionsOf().traffic).toBe('live');
      expect(optionsOf().departAt).toBe(T_ISO);
    });
  }

  it('a passthrough options.departAt still wins under none', async () => {
    await capture(() =>
      tomtomMatrix().matrix({
        origins: ORIGINS,
        destinations: DESTINATIONS,
        trafficMode: 'none',
        departureTime: T,
        _passthrough: { body: { options: { departAt: T_ISO } } },
      }),
    );
    expect(optionsOf().traffic).toBe('historical');
    expect(optionsOf().departAt).toBe(T_ISO);
  });
});

// 'live' is a deprecated alias of 'traffic': every connector must put the exact
// same request on the wire for both, with and without a departure time.
describe("'live' ≡ 'traffic' on the wire", () => {
  type Run = (trafficMode: TrafficMode, departureTime?: Date) => Promise<unknown>;
  // Mapbox Optimization and Matrix reject traffic + a time before any request
  // (covered above), so only their no-time request is compared.
  const NO_TIME_ONLY = new Set(['mapbox optimization', 'mapbox matrix']);
  const THREE = [...TWO, { lat: 2, lng: 2 }];
  const osrmConfig = { baseUrl: 'https://osrm.example.com' };

  const connectors: [string, Run][] = [
    ['google routes', (trafficMode, departureTime) => google().route({ waypoints: TWO, trafficMode, departureTime })],
    ['google matrix', (trafficMode, departureTime) => googleMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode, departureTime })],
    ['here routes', (trafficMode, departureTime) => here().route({ waypoints: TWO, trafficMode, departureTime })],
    ['here matrix', (trafficMode, departureTime) => hereMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode, departureTime })],
    ['esri routing', (trafficMode, departureTime) => esri().route({ waypoints: TWO, trafficMode, departureTime })],
    ['esri matrix', (trafficMode, departureTime) => esriMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode, departureTime })],
    ['mapbox directions', (trafficMode, departureTime) => mapbox().route({ waypoints: TWO, trafficMode, departureTime })],
    ['mapbox optimization', (trafficMode) => mapbox().route({ waypoints: THREE, optimize: true, trafficMode })],
    ['mapbox matrix', (trafficMode) => mapboxMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode })],
    ['tomtom routing', (trafficMode, departureTime) => tomtom().route({ waypoints: TWO, trafficMode, departureTime })],
    ['tomtom matrix', (trafficMode, departureTime) => tomtomMatrix().matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode, departureTime })],
    ['osrm routing', (trafficMode, departureTime) => new OsrmRoutingConnector(osrmConfig).route({ waypoints: TWO, trafficMode, departureTime })],
    ['osrm matrix', (trafficMode, departureTime) => new OsrmMatrixConnector(osrmConfig).matrix({ origins: ORIGINS, destinations: DESTINATIONS, trafficMode, departureTime })],
  ];

  for (const [name, run] of connectors) {
    for (const departureTime of NO_TIME_ONLY.has(name) ? [undefined] : [undefined, T]) {
      it(`${name} ${departureTime ? '+ time' : ', no time'}`, async () => {
        // URL, method, headers and body — not the whole init, whose AbortSignal
        // is a fresh object per request.
        const wire = () => {
          const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
          return { url, method: init.method, headers: init.headers, body: init.body };
        };
        await capture(() => run('traffic', departureTime));
        const asTraffic = wire();
        mockFetch.mockReset();
        await capture(() => run('live', departureTime));
        expect(wire()).toEqual(asTraffic);
      });
    }
  }
});
