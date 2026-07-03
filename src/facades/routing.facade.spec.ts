import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Routing } from './routing.facade';
import { ConnectorError } from '../types';
import type { IRoutingOptions, LatLng, RoutingOptionsFor } from '../types';
import { encodePolyline } from '../utils';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildGoogleRoutesResponse() {
  return new Response(
    JSON.stringify({
      routes: [
        {
          legs: [{ distanceMeters: 5000, duration: '300s', staticDuration: '300s' }],
          distanceMeters: 5000,
          duration: '300s',
          staticDuration: '300s',
          polyline: { encodedPolyline: 'google_poly' },
        },
      ],
    }),
    { status: 200 }
  );
}

function buildOsrmRouteResponse() {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      routes: [
        {
          geometry: 'osrm_poly',
          legs: [{ distance: 8000, duration: 600 }],
          distance: 8000,
          duration: 600,
        },
      ],
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
    }),
    { status: 200 }
  );
}

// Mapbox returns `polyline6` geometry by default; the
// connector re-encodes it to canonical precision-5. We encode the
// same sample coordinates at precision-6 for the fixture and at precision-5
// for the expected assertion.
const MAPBOX_FIXTURE_COORDS: LatLng[] = [
  { lat: 38.5, lng: -120.2 },
  { lat: 40.7, lng: -120.95 },
];

function encodePolyline6(coords: LatLng[]): string {
  const encodeSigned = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
    return out;
  };
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const c of coords) {
    const lat = Math.round(c.lat * 1e6);
    const lng = Math.round(c.lng * 1e6);
    output += encodeSigned(lat - prevLat);
    output += encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return output;
}

const MAPBOX_FIXTURE_POLY6 = encodePolyline6(MAPBOX_FIXTURE_COORDS);
const MAPBOX_EXPECTED_POLY5 = encodePolyline(MAPBOX_FIXTURE_COORDS);

function buildMapboxDirectionsResponse() {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      routes: [
        {
          geometry: MAPBOX_FIXTURE_POLY6,
          legs: [{ distance: 7000, duration: 500 }],
          distance: 7000,
          duration: 500,
        },
      ],
      waypoints: [{ name: 'A' }, { name: 'B' }],
    }),
    { status: 200 }
  );
}

const waypoints = [
  { lat: 40.7128, lng: -74.006 },
  { lat: 40.758, lng: -73.9855 },
];

describe('Routing (unified facade)', () => {
  it('should create a Google routing connector and delegate route()', async () => {
    mockFetch.mockResolvedValueOnce(buildGoogleRoutesResponse());

    const routing = new Routing('google', { apiKey: 'gk' });
    expect(routing.providerId).toBe('google');

    const result = await routing.route({ waypoints });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(result.totalDistanceMeters).toBe(5000);
    expect(result.polyline).toBe('google_poly');
  });

  it('should create a Mapbox routing connector and delegate route()', async () => {
    mockFetch.mockResolvedValueOnce(buildMapboxDirectionsResponse());

    const routing = new Routing('mapbox', { accessToken: 'pk.xxx' });
    expect(routing.providerId).toBe('mapbox');

    const result = await routing.route({ waypoints });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init?.method).toBe('GET');
    expect(result.totalDistanceMeters).toBe(7000);
    expect(result.polyline).toBe(MAPBOX_EXPECTED_POLY5);
  });

  it('should create an OSRM routing connector and delegate route()', async () => {
    mockFetch.mockResolvedValueOnce(buildOsrmRouteResponse());

    const routing = new Routing('osrm', { baseUrl: 'http://localhost:5000' });
    expect(routing.providerId).toBe('osrm');

    const result = await routing.route({ waypoints });

    expect(result.totalDistanceMeters).toBe(8000);
    expect(result.polyline).toBe('osrm_poly');
  });

  it('should create a HERE routing connector', () => {
    const routing = new Routing('here', { apiKey: 'hk' });
    expect(routing.providerId).toBe('here');
  });

  it('should create an ESRI routing connector', () => {
    const routing = new Routing('esri', { apiKey: 'ek' });
    expect(routing.providerId).toBe('esri');
  });

  it('should create a TomTom routing connector', () => {
    const routing = new Routing('tomtom', { apiKey: 'tk' });
    expect(routing.providerId).toBe('tomtom');
  });

  it('should throw on unknown provider', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new Routing('unknown' as any, {} as any)
    ).toThrow('Unknown routing provider: unknown');
  });

  it('should propagate ConnectorError from underlying connector', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    );

    const routing = new Routing('google', { apiKey: 'gk' });
    await expect(routing.route({ waypoints })).rejects.toBeInstanceOf(ConnectorError);
  });

  it('uses the injected fetchImpl when one is supplied to the facade', async () => {
    const customFetch = vi.fn().mockResolvedValue(buildGoogleRoutesResponse());
    const routing = new Routing('google', { apiKey: 'gk' }, customFetch);
    await routing.route({ waypoints });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Routing facade — type-level narrowing tests', () => {
  // 7a. Positive narrowing — one per provider; constructor type-checks with the
  // correct config shape, and `providerId` literal-narrows to the requested id.
  it('accepts GoogleConfig for new Routing("google", ...)', () => {
    const r = new Routing('google', { apiKey: 'k' });
    expect(r.providerId).toBe('google');
  });

  it('accepts MapboxConfig for new Routing("mapbox", ...)', () => {
    const r = new Routing('mapbox', { accessToken: 'pk.xxx' });
    expect(r.providerId).toBe('mapbox');
  });

  it('accepts HereConfig for new Routing("here", ...)', () => {
    const r = new Routing('here', { apiKey: 'hk' });
    expect(r.providerId).toBe('here');
  });

  it('accepts EsriConfig for new Routing("esri", ...)', () => {
    const r = new Routing('esri', { apiKey: 'ek' });
    expect(r.providerId).toBe('esri');
  });

  it('accepts OsrmConfig for new Routing("osrm", ...)', () => {
    const r = new Routing('osrm', { baseUrl: 'http://localhost:5000' });
    expect(r.providerId).toBe('osrm');
  });

  it('accepts TomTomConfig for new Routing("tomtom", ...)', () => {
    const r = new Routing('tomtom', { apiKey: 'tk' });
    expect(r.providerId).toBe('tomtom');
  });

  // 7b. Negative narrowing — wrong config shape produces @ts-expect-error.
  it('rejects MapboxConfig for new Routing("google", ...) at compile time', () => {
    // @ts-expect-error MapboxConfig (`accessToken`) is not assignable to GoogleConfig (`apiKey`).
    const _r = new Routing('google', { accessToken: 'pk.xxx' });
    void _r;
    expect(true).toBe(true);
  });

  it('rejects GoogleConfig for new Routing("mapbox", ...) at compile time', () => {
    // @ts-expect-error GoogleConfig (`apiKey`) is not assignable to MapboxConfig (`accessToken`).
    const _r = new Routing('mapbox', { apiKey: 'k' });
    void _r;
    expect(true).toBe(true);
  });

  it('rejects passing fetchImpl as second arg (config required) at compile time', () => {
    // Compile-time-only assertion: wrap in an unreachable factory so we don't
    // execute the runtime path (which would just construct against fetch).
    const _factory = () =>
      // @ts-expect-error config is required (second positional); fetch is not a valid config.
      new Routing('google', globalThis.fetch);
    void _factory;
    expect(true).toBe(true);
  });

  it('rejects unknown provider id at compile time', () => {
    // Compile-time-only assertion: wrap in an unreachable factory so we don't
    // execute the runtime path (which would throw "Unknown routing provider").
    const _factory = () =>
      // @ts-expect-error 'novu' is not a RoutingProvider.
      new Routing('novu', { apiKey: 'k' });
    void _factory;
    expect(true).toBe(true);
  });

  // 7c. `RoutingOptionsFor<P>` resolves to `IRoutingOptions` at v1.0 (no augmentations yet).
  it('RoutingOptionsFor<P> resolves to IRoutingOptions when P has not augmented', () => {
    const _r = new Routing('google', { apiKey: 'k' });
    // The facade's `.route` parameter accepts the full base `IRoutingOptions` shape:
    const input: Parameters<typeof _r.route>[0] = {
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      optimize: true,
      optimizeFixedOrigin: true,
      optimizeFixedDestination: true,
      isRoundTrip: false,
      departureTime: new Date(),
      avoidTolls: true,
      avoidFerries: true,
      avoidHighways: false,
      travelMode: 'driving',
      _passthrough: { body: { foo: 'bar' }, headers: { 'X-Trace': 't' }, query: { q: '1' } },
    };
    void input;
    expect(true).toBe(true);
  });

  it('RoutingOptionsFor<"google"> is structurally compatible with IRoutingOptions at v1.0', () => {
    // Compile-time assertion: an `IRoutingOptions` value is assignable to
    // `RoutingOptionsFor<'google'>` and vice versa (the conditional falls back
    // to `IRoutingOptions` because the empty base `RoutingOptionsMap` has no
    // `'google'` key).
    const base: IRoutingOptions = { waypoints: [{ lat: 0, lng: 0 }] };
    const narrowed: RoutingOptionsFor<'google'> = base;
    const baseFromNarrowed: IRoutingOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });
});
