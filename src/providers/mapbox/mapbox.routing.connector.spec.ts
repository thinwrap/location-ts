import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapboxRoutingConnector } from './mapbox.routing.connector';
import type { MapboxConfig } from './mapbox.config';
import { ConnectorError } from '../../types';
import type { LatLng } from '../../types';
import { decodePolyline, encodePolyline } from '../../utils';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: MapboxConfig = { accessToken: 'pk.test123' };

/**
 * Encode a list of LatLng coordinates into a precision-6 polyline — used to
 * stub Mapbox responses without coupling to the connector's internal decoder.
 */
function encodePolyline6(coords: LatLng[]): string {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const c of coords) {
    const lat = Math.round(c.lat * 1e6);
    const lng = Math.round(c.lng * 1e6);
    output += encodeSignedVarint(lat - prevLat);
    output += encodeSignedVarint(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return output;
}

function encodeSignedVarint(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

const SAMPLE_LATLNGS: LatLng[] = [
  { lat: 38.5, lng: -120.2 },
  { lat: 40.7, lng: -120.95 },
  { lat: 43.252, lng: -126.453 },
];

function buildDirectionsResponse(
  overrides: Partial<{
    geometry: string;
    legs: Array<{ distance: number; duration: number }>;
    distance: number;
    duration: number;
    code: string;
    waypoints: Array<{ name?: string; waypoint_index?: number }>;
  }> = {},
) {
  return new Response(
    JSON.stringify({
      code: overrides.code ?? 'Ok',
      routes: [
        {
          geometry: overrides.geometry ?? encodePolyline6(SAMPLE_LATLNGS),
          legs: overrides.legs ?? [{ distance: 5000, duration: 300 }],
          distance: overrides.distance ?? 5000,
          duration: overrides.duration ?? 300,
        },
      ],
      waypoints: overrides.waypoints ?? [
        { name: 'A', waypoint_index: 0 },
        { name: 'B', waypoint_index: 1 },
      ],
    }),
    { status: 200 },
  );
}

function buildOptimizedTripsResponse(
  overrides: Partial<{
    geometry: string;
    waypoints: Array<{ name?: string; waypoint_index?: number }>;
  }> = {},
) {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      trips: [
        {
          geometry: overrides.geometry ?? encodePolyline6(SAMPLE_LATLNGS),
          legs: [
            { distance: 3000, duration: 180 },
            { distance: 4000, duration: 240 },
          ],
          distance: 7000,
          duration: 420,
        },
      ],
      waypoints: overrides.waypoints ?? [
        { name: 'A', waypoint_index: 0 },
        { name: 'C', waypoint_index: 2 },
        { name: 'B', waypoint_index: 1 },
      ],
    }),
    { status: 200 },
  );
}

function parseUrlParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.substring(q + 1) : '');
}

describe('MapboxRoutingConnector', () => {
  let connector: MapboxRoutingConnector;

  beforeEach(() => {
    connector = new MapboxRoutingConnector(defaultConfig);
  });

  it('should have providerId "mapbox"', () => {
    expect(connector.providerId).toBe('mapbox');
  });

  describe('dispatch routing', () => {
    it('uses GET /directions/v5 when no optimization flags are set', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());

      const result = await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
        ],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain('https://api.mapbox.com/directions/v5/mapbox/driving/');
      expect(url).toContain('-74.006,40.7128;-73.9855,40.758');
      expect(init?.method).toBe('GET');
      const params = parseUrlParams(url as string);
      expect(params.get('access_token')).toBe('pk.test123');
      expect(params.get('geometries')).toBe('polyline6');
      // Default fidelity is `simplified` — a 30x smaller geometry than `full`
      // with identical distances/durations.
      expect(params.get('overview')).toBe('simplified');
      // Neither is read by any normalized field, and steps are the largest part
      // of a Mapbox response — so neither is requested.
      expect(params.has('steps')).toBe(false);
      expect(params.has('annotations')).toBe(false);
      expect(result.totalDistanceMeters).toBe(5000);
      expect(result.totalDurationSeconds).toBe(300);
    });

    it('uses GET /optimized-trips/v1 when optimize=true', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());

      await connector.route({
        waypoints: [
          { lat: 40.7128, lng: -74.006 },
          { lat: 40.758, lng: -73.9855 },
          { lat: 40.7484, lng: -73.9856 },
        ],
        optimize: true,
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain(
        'https://api.mapbox.com/optimized-trips/v1/mapbox/driving/',
      );
      // Coordinates ride in the path (lng,lat;…), not a POST body.
      expect(url).toContain('-74.006,40.7128;-73.9855,40.758;-73.9856,40.7484');
      expect(init?.method).toBe('GET');
    });

    it('dispatches to /optimized-trips/v1 when only optimizeFixedOrigin is set', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimizeFixedOrigin: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('/optimized-trips/v1/mapbox');
    });

    it('dispatches to /optimized-trips/v1 when only optimizeFixedDestination is set', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimizeFixedDestination: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('/optimized-trips/v1/mapbox');
    });

    it('dispatches to /optimized-trips/v1 when only isRoundTrip is set', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        isRoundTrip: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('/optimized-trips/v1/mapbox');
    });
  });

  describe('optimization flag mapping', () => {
    // v1 (OSRM-trip-based) rejects source=any + destination=any + roundtrip=false,
    // so plain optimize keeps BOTH endpoints and reorders the middle — matching
    // Google/TomTom/HERE/Esri.
    it('plain optimize=true keeps endpoints (source=first, destination=last)', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('source')).toBe('first');
      expect(params.get('destination')).toBe('last');
      expect(params.get('roundtrip')).toBe('false');
    });

    it('optimizeFixedOrigin pins source to "first" and frees the destination', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimizeFixedOrigin: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('source')).toBe('first');
      expect(params.get('destination')).toBe('any');
    });

    it('optimizeFixedDestination pins destination to "last" and frees the source', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimizeFixedDestination: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('source')).toBe('any');
      expect(params.get('destination')).toBe('last');
    });

    it('isRoundTrip=true emits roundtrip=true (source=first)', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        isRoundTrip: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('roundtrip')).toBe('true');
      expect(params.get('source')).toBe('first');
    });

    it('maps canonical waypointOrder by inverting waypoints[].waypoint_index', async () => {
      // Default fixture: input order A,B,C with waypoint_index 0,2,1 (visit
      // positions). Inverting to visiting-order-of-input-indices yields the
      // canonical [0,2,1] (this permutation is its own inverse).
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
      });
      expect(result.waypointOrder).toEqual([0, 2, 1]);
    });

    // Cross-language canonical waypointOrder parity fixture. Logical input
    // [A,B,C,D]; optimal visiting order A,C,B,D ⇒ canonical [0,2,1,3].
    // Mapbox reports waypoints[] in INPUT order with waypoint_index = visit
    // position: A→0, B→2, C→1, D→3. Inverting yields [0,2,1,3].
    it('canonical waypointOrder: full visiting sequence of input indices', async () => {
      mockFetch.mockResolvedValueOnce(
        buildOptimizedTripsResponse({
          waypoints: [
            { name: 'A', waypoint_index: 0 },
            { name: 'B', waypoint_index: 2 },
            { name: 'C', waypoint_index: 1 },
            { name: 'D', waypoint_index: 3 },
          ],
        }),
      );
      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
          { lat: 3, lng: 3 },
        ],
        optimize: true,
      });
      expect(result.waypointOrder).toEqual([0, 2, 1, 3]);
    });

    // Discriminating NON-involution fixture. The fixtures above use self-inverse
    // permutations, so reverting the inverter would still pass. Vendor
    // `waypoint_index = [1,2,0]` is a 3-cycle: its inverse `[2,0,1]` differs from
    // the raw `[1,2,0]`. Inverting per `order[waypoint_index[i]] = i` gives
    // order[1]=0, order[2]=1, order[0]=2 ⇒ canonical [2,0,1], LOCKING direction.
    it('locks inversion direction with a non-involution permutation', async () => {
      mockFetch.mockResolvedValueOnce(
        buildOptimizedTripsResponse({
          waypoints: [
            { name: 'A', waypoint_index: 1 },
            { name: 'B', waypoint_index: 2 },
            { name: 'C', waypoint_index: 0 },
          ],
        }),
      );
      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
      });
      // Canonical inverse of [1,2,0] is [2,0,1] (NOT the raw [1,2,0]).
      expect(result.waypointOrder).toEqual([2, 0, 1]);
    });

    // The inversion is validated against the INPUT waypoint count and tracks
    // which visit positions have been filled. Before that, a duplicate
    // `waypoint_index` overwrote one slot and left another unwritten — an
    // `undefined` hole in an array still typed `number[]`.
    it.each([
      [
        'duplicate waypoint_index values',
        [
          { name: 'A', waypoint_index: 0 },
          { name: 'B', waypoint_index: 0 },
          { name: 'C', waypoint_index: 2 },
        ],
      ],
      [
        'a truncated waypoints array',
        [
          { name: 'A', waypoint_index: 0 },
          { name: 'B', waypoint_index: 1 },
        ],
      ],
      [
        'an out-of-range waypoint_index',
        [
          { name: 'A', waypoint_index: 0 },
          { name: 'B', waypoint_index: 1 },
          { name: 'C', waypoint_index: 7 },
        ],
      ],
      [
        'a missing waypoint_index',
        [
          { name: 'A', waypoint_index: 0 },
          { name: 'B' },
          { name: 'C', waypoint_index: 2 },
        ],
      ],
    ])('omits waypointOrder for %s', async (_label, waypoints) => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse({ waypoints }));

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
      });

      expect(result.waypointOrder).toBeUndefined();
      // The trip itself is still returned.
      expect(result.totalDistanceMeters).toBe(7000);
    });
  });

  describe('precision-6 to precision-5 polyline re-encoding', () => {
    it('decodes precision-6 source and re-encodes as precision-5', async () => {
      const precision6 = encodePolyline6(SAMPLE_LATLNGS);
      const expected = encodePolyline(SAMPLE_LATLNGS);
      mockFetch.mockResolvedValueOnce(
        buildDirectionsResponse({ geometry: precision6 }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 38.5, lng: -120.2 },
          { lat: 43.252, lng: -126.453 },
        ],
      });

      expect(result.polyline).toBe(expected);
      // Round-trip through the precision-5 decoder must land within 5e-5 of
      // the original coordinates tolerance.
      const decoded = decodePolyline(result.polyline);
      expect(decoded).toHaveLength(SAMPLE_LATLNGS.length);
      for (let i = 0; i < SAMPLE_LATLNGS.length; i++) {
        expect(Math.abs(decoded[i]!.lat - SAMPLE_LATLNGS[i]!.lat)).toBeLessThan(
          5e-5,
        );
        expect(Math.abs(decoded[i]!.lng - SAMPLE_LATLNGS[i]!.lng)).toBeLessThan(
          5e-5,
        );
      }
    });

    it('emits an empty polyline when Mapbox returns no geometry', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse({ geometry: '' }));
      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });
      expect(result.polyline).toBe('');
    });
  });

  // `_passthrough` overriding connector-set query params is a documented escape
  // hatch, but `geometries` is COUPLED to the decoder: a precision-5 `polyline`
  // decoded at precision 6 divides every coordinate by 10 — a silent 10x
  // position shift. The decoder therefore follows the effective request value.
  describe('geometries / decoder coupling via _passthrough', () => {
    const TWO_WAYPOINTS = [
      { lat: 38.5, lng: -120.2 },
      { lat: 43.252, lng: -126.453 },
    ];

    it('sends geometries=polyline6 by default', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({ waypoints: TWO_WAYPOINTS });

      const [url] = mockFetch.mock.calls[0]!;
      expect(parseUrlParams(url as string).get('geometries')).toBe('polyline6');
    });

    it('treats an overridden geometries=polyline as already precision-5', async () => {
      // A precision-5 polyline of the sample coordinates, served as-is.
      const precision5 = encodePolyline(SAMPLE_LATLNGS);
      mockFetch.mockResolvedValueOnce(
        buildDirectionsResponse({ geometry: precision5 }),
      );

      const result = await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { query: { geometries: 'polyline' } },
      });

      // Emitted verbatim — NOT run through the precision-6 decoder.
      expect(result.polyline).toBe(precision5);
      const decoded = decodePolyline(result.polyline);
      expect(decoded).toHaveLength(SAMPLE_LATLNGS.length);
      for (let i = 0; i < SAMPLE_LATLNGS.length; i++) {
        expect(Math.abs(decoded[i]!.lat - SAMPLE_LATLNGS[i]!.lat)).toBeLessThan(
          5e-5,
        );
        expect(Math.abs(decoded[i]!.lng - SAMPLE_LATLNGS[i]!.lng)).toBeLessThan(
          5e-5,
        );
      }
    });

    it('does not shift coordinates 10x when geometries is overridden', async () => {
      const precision5 = encodePolyline(SAMPLE_LATLNGS);
      mockFetch.mockResolvedValueOnce(
        buildDirectionsResponse({ geometry: precision5 }),
      );

      const result = await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { query: { geometries: 'polyline' } },
      });

      // The regression this guards: decoding precision-5 at precision 6 yields
      // ~3.85 instead of ~38.5.
      const decoded = decodePolyline(result.polyline);
      expect(decoded[0]!.lat).toBeCloseTo(38.5, 4);
      expect(decoded[0]!.lat / 10).not.toBeCloseTo(38.5, 4);
    });

    it('encodes a GeoJSON LineString when geometries=geojson is requested', async () => {
      mockFetch.mockResolvedValueOnce(
        buildDirectionsResponse({
          // GeoJSON is [lng, lat] order.
          geometry: {
            type: 'LineString',
            coordinates: SAMPLE_LATLNGS.map((c) => [c.lng, c.lat]),
          } as unknown as string,
        }),
      );

      const result = await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { query: { geometries: 'geojson' } },
      });

      expect(result.polyline).toBe(encodePolyline(SAMPLE_LATLNGS));
    });

    it('emits an empty polyline for a malformed GeoJSON geometry', async () => {
      mockFetch.mockResolvedValueOnce(
        buildDirectionsResponse({
          geometry: {
            type: 'LineString',
            coordinates: [['x', 'y']],
          } as unknown as string,
        }),
      );

      const result = await connector.route({
        waypoints: TWO_WAYPOINTS,
        _passthrough: { query: { geometries: 'geojson' } },
      });

      expect(result.polyline).toBe('');
      // The route itself is still returned.
      expect(result.totalDistanceMeters).toBe(5000);
    });

    it('honors the override on the optimized-trips dispatch too', async () => {
      const precision5 = encodePolyline(SAMPLE_LATLNGS);
      mockFetch.mockResolvedValueOnce(
        buildOptimizedTripsResponse({ geometry: precision5 }),
      );

      const result = await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
        _passthrough: { query: { geometries: 'polyline' } },
      });

      expect(result.polyline).toBe(precision5);
    });
  });

  describe('travel mode + avoid options', () => {
    it('maps cycling travel mode to /mapbox/cycling/', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'cycling',
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('/mapbox/cycling/');
    });

    it('maps walking travel mode to /mapbox/walking/', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        travelMode: 'walking',
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('/mapbox/walking/');
    });

    it('includes exclude param for avoidTolls and avoidFerries (directions)', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        avoidTolls: true,
        avoidFerries: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('exclude')).toBe('toll,ferry');
    });

    it('includes exclude param for avoidHighways on optimized-trips dispatch', async () => {
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        optimize: true,
        avoidHighways: true,
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('exclude')).toBe('motorway');
    });

    // Mapbox enumerates exactly three accepted ISO 8601 forms for `depart_at`
    // (`YYYY-MM-DDThh:mm:ssZ`, `…±hh:mm`, `YYYY-MM-DDThh:mm`); the millisecond
    // form `toISOString()` produces is not one of them.
    it('emits depart_at at seconds precision when departureTime is set', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        departureTime: new Date('2024-01-15T08:00:00.750Z'),
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('depart_at')).toBe('2024-01-15T08:00:00Z');
    });
  });

  describe('mergePassthrough', () => {
    it('merges _passthrough.query into the directions URL', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
        _passthrough: { query: { language: 'fr' } },
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('language')).toBe('fr');
    });

    it('merges _passthrough.query into the optimized-trips request query', async () => {
      // Optimization v1 is a GET, so the escape hatch is `_passthrough.query`
      // (which can also override a connector-set default like `annotations`).
      mockFetch.mockResolvedValueOnce(buildOptimizedTripsResponse());
      await connector.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
        optimize: true,
        _passthrough: { query: { annotations: 'duration' } },
      });
      const [url] = mockFetch.mock.calls[0]!;
      const params = parseUrlParams(url as string);
      expect(params.get('annotations')).toBe('duration');
    });

    it('merges _passthrough.headers onto requests', async () => {
      mockFetch.mockResolvedValueOnce(buildDirectionsResponse());
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

  describe('mapVendorError', () => {
    const cases: Array<{
      label: string;
      status: number;
      body: Record<string, unknown> | null;
      expected: string;
    }> = [
      { label: 'HTTP 401 → auth_failed', status: 401, body: null, expected: 'auth_failed' },
      { label: 'HTTP 403 → auth_failed', status: 403, body: null, expected: 'auth_failed' },
      {
        label: 'HTTP 422 NoRoute → no_route',
        status: 422,
        body: { code: 'NoRoute' },
        expected: 'no_route',
      },
      {
        label: 'HTTP 422 NoTrips → no_route',
        status: 422,
        body: { code: 'NoTrips' },
        expected: 'no_route',
      },
      {
        label: 'HTTP 422 ProcessingError → unknown',
        status: 422,
        body: { code: 'ProcessingError' },
        expected: 'unknown',
      },
      { label: 'HTTP 429 → rate_limited', status: 429, body: null, expected: 'rate_limited' },
      {
        label: 'HTTP 500 → provider_unavailable',
        status: 500,
        body: null,
        expected: 'provider_unavailable',
      },
      {
        label: 'HTTP 503 → provider_unavailable',
        status: 503,
        body: null,
        expected: 'provider_unavailable',
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(c.body ? JSON.stringify(c.body) : '', { status: c.status }),
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

    it('throws ConnectorError on 200-OK envelope with code !== "Ok"', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'NoRoute', routes: [] }), {
          status: 200,
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
      // Live-verified: Mapbox serves its no-route envelope with HTTP **200**
      // (`{ code: 'NoRoute', routes: [] }`) as well as with 422 — the envelope
      // code, not the status, is the signal.
      expect((thrown as ConnectorError).providerCode).toBe('no_route');
    });

    // Success-path malformed body: a 200 OK whose JSON fails to parse yields
    // null via `.catch(() => null)` and must surface a typed ConnectorError
    // rather than an uncaught SyntaxError.
    it('throws ConnectorError on a malformed (non-JSON) 200 body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
      let thrown: ConnectorError | null = null;
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
      expect(thrown?.providerCode).toBe('unknown');
      expect(thrown?.message).toBe('Mapbox returned a malformed response body');
    });
  });

  describe('waypoint guard', () => {
    it('rejects fewer than two waypoints with ConnectorError invalid_request (no fetch)', async () => {
      await expect(
        connector.route({ waypoints: [{ lat: 38.5, lng: -120.2 }] }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
        message: 'Mapbox Routing requires at least two waypoints',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an empty waypoints array without a network call', async () => {
      await expect(connector.route({ waypoints: [] })).rejects.toBeInstanceOf(
        ConnectorError,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('non-finite coordinate guard', () => {
    it('rejects a NaN waypoint on the plain /directions path (no fetch)', async () => {
      await expect(
        connector.route({
          waypoints: [
            { lat: Number.NaN, lng: -120.2 },
            { lat: 40.7, lng: -120.95 },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a NaN waypoint on the optimized /optimized-trips path (optimize=true, no fetch)', async () => {
      await expect(
        connector.route({
          optimize: true,
          waypoints: [
            { lat: 38.5, lng: -120.2 },
            { lat: Number.NaN, lng: -120.95 },
            { lat: 43.252, lng: -126.453 },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an Infinity waypoint on the optimized path via isRoundTrip (no fetch)', async () => {
      await expect(
        connector.route({
          isRoundTrip: true,
          waypoints: [
            { lat: 38.5, lng: -120.2 },
            { lat: 40.7, lng: Number.POSITIVE_INFINITY },
          ],
        }),
      ).rejects.toMatchObject({
        name: 'ConnectorError',
        providerCode: 'invalid_request',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
