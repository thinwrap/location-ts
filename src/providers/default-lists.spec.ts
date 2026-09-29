import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Imported from the package entry, not the defining modules: the point of these
// constants is that consumers can reach them.
import {
  ESRI_MATRIX_ACCUMULATE_ATTRIBUTES,
  ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING,
  ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING,
  GOOGLE_MATRIX_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME,
  GOOGLE_ROUTES_FIELD_MASK,
  GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC,
  GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER,
  HERE_MATRIX_ATTRIBUTES,
  HERE_ROUTING_RETURN,
  MAPBOX_MATRIX_ANNOTATIONS,
  OSRM_TABLE_ANNOTATIONS,
} from '../index';
import { ConnectorError } from '../types';
import { EsriMatrixConnector } from './esri/esri.matrix.connector';
import { EsriRoutingConnector } from './esri/esri.routing.connector';
import { GoogleGeocodingConnector } from './google/google.geocoding.connector';
import { GoogleMatrixConnector } from './google/google.matrix.connector';
import { GoogleRoutingConnector } from './google/google.routing.connector';
import { HereMatrixConnector } from './here/here.matrix.connector';
import { HereRoutingConnector } from './here/here.routing.connector';
import { MapboxMatrixConnector } from './mapbox/mapbox.matrix.connector';
import { OsrmMatrixConnector } from './osrm/osrm.matrix.connector';

/**
 * Published default lists vs. what the connectors send.
 *
 * A passthrough field mask / `return` REPLACES the connector's list on purpose —
 * an additive merge would leave no way to drop a default. The published constants
 * are the supported way to extend one, which only works if they are exactly what
 * goes on the wire in every conditional combination.
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
const THREE = [...TWO, { lat: 2, lng: 2 }];

function resp(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function headerOf(name: string): string | undefined {
  const [, init] = mockFetch.mock.calls[0]!;
  return ((init as RequestInit).headers as Record<string, string>)[name];
}

function queryOf(): URLSearchParams {
  const url = mockFetch.mock.calls[0]![0] as string;
  return new URLSearchParams(url.split('?')[1] ?? '');
}

const GOOGLE_ROUTES_BODY = {
  routes: [
    {
      legs: [{ distanceMeters: 5000, duration: '300s' }],
      distanceMeters: 5000,
      duration: '300s',
      polyline: { encodedPolyline: 'abc' },
    },
  ],
};

const GOOGLE_MATRIX_NDJSON = JSON.stringify({
  originIndex: 0,
  destinationIndex: 0,
  distanceMeters: 100,
  duration: '10s',
  condition: 'ROUTE_EXISTS',
});

const GOOGLE_PLACE_BODY = {
  id: 'p1',
  formattedAddress: 'somewhere',
  location: { latitude: 1, longitude: 2 },
};

const HERE_ROUTES_BODY = {
  routes: [
    {
      sections: [{ polyline: 'BGwl_lgDo-6-T', summary: { length: 5000, duration: 300 } }],
    },
  ],
};

function routeGoogle(extra: Record<string, unknown> = {}, waypoints = TWO) {
  mockFetch.mockResolvedValueOnce(resp(GOOGLE_ROUTES_BODY));
  return new GoogleRoutingConnector({ apiKey: 'k' }).route({ waypoints, ...extra });
}

function matrixGoogle(extra: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValueOnce(new Response(GOOGLE_MATRIX_NDJSON, { status: 200 }));
  return new GoogleMatrixConnector({ apiKey: 'k' }).matrix({
    origins: [TWO[0]!],
    destinations: [TWO[1]!],
    ...extra,
  });
}

function placeDetailsGoogle(extra: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValueOnce(resp(GOOGLE_PLACE_BODY));
  return new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({
    placeId: 'p1',
    ...extra,
  });
}

function routeHere(extra: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValueOnce(resp(HERE_ROUTES_BODY));
  return new HereRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO, ...extra });
}

describe('published default lists', () => {
  // Pinned literally so a change to what the library sends is a deliberate edit
  // here, not a side effect — every consumer who spreads a constant inherits it.
  it('hold the documented values', () => {
    expect(GOOGLE_ROUTES_FIELD_MASK).toEqual([
      'routes.legs.distanceMeters',
      'routes.legs.duration',
      'routes.distanceMeters',
      'routes.duration',
      'routes.polyline.encodedPolyline',
    ]);
    expect(GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC).toEqual([
      'routes.legs.staticDuration',
      'routes.staticDuration',
    ]);
    expect(GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER).toEqual([
      'routes.optimizedIntermediateWaypointIndex',
    ]);
    expect(GOOGLE_MATRIX_FIELD_MASK).toEqual([
      'originIndex',
      'destinationIndex',
      'distanceMeters',
      'duration',
      'status',
      'condition',
    ]);
    expect(GOOGLE_PLACE_DETAILS_FIELD_MASK).toEqual([
      'id',
      'formattedAddress',
      'location',
      'viewport',
    ]);
    expect(GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME).toEqual(['displayName']);
    expect(HERE_ROUTING_RETURN).toEqual(['polyline', 'summary']);
    expect(HERE_MATRIX_ATTRIBUTES).toEqual(['travelTimes', 'distances']);
    expect(MAPBOX_MATRIX_ANNOTATIONS).toEqual(['duration', 'distance']);
    expect(OSRM_TABLE_ANNOTATIONS).toEqual(['duration', 'distance']);
    expect(ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING).toEqual(['TravelTime', 'Kilometers']);
    expect(ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING).toEqual(['WalkTime', 'Kilometers']);
    expect(ESRI_MATRIX_ACCUMULATE_ATTRIBUTES).toEqual(['Kilometers']);
  });

  // The connectors build every request from these arrays, so a caller mutating
  // one would silently change every later request in the process.
  it.each([
    ['GOOGLE_ROUTES_FIELD_MASK', GOOGLE_ROUTES_FIELD_MASK],
    ['GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC', GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC],
    ['GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER', GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER],
    ['GOOGLE_MATRIX_FIELD_MASK', GOOGLE_MATRIX_FIELD_MASK],
    ['GOOGLE_PLACE_DETAILS_FIELD_MASK', GOOGLE_PLACE_DETAILS_FIELD_MASK],
    ['GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME', GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME],
    ['HERE_ROUTING_RETURN', HERE_ROUTING_RETURN],
    ['HERE_MATRIX_ATTRIBUTES', HERE_MATRIX_ATTRIBUTES],
    ['MAPBOX_MATRIX_ANNOTATIONS', MAPBOX_MATRIX_ANNOTATIONS],
    ['OSRM_TABLE_ANNOTATIONS', OSRM_TABLE_ANNOTATIONS],
    ['ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING', ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING],
    ['ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING', ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING],
    ['ESRI_MATRIX_ACCUMULATE_ATTRIBUTES', ESRI_MATRIX_ACCUMULATE_ATTRIBUTES],
  ])('%s is frozen at runtime', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as unknown as string[]).push('x')).toThrow(TypeError);
  });
});

describe('default wire value equals the published constants', () => {
  it('Google routes: base only', async () => {
    await routeGoogle();
    expect(headerOf('X-Goog-FieldMask')).toBe(GOOGLE_ROUTES_FIELD_MASK.join(','));
  });

  it('Google routes: base + durationWithoutTraffic', async () => {
    await routeGoogle({ include: ['durationWithoutTraffic'] });
    expect(headerOf('X-Goog-FieldMask')).toBe(
      [...GOOGLE_ROUTES_FIELD_MASK, ...GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC].join(','),
    );
  });

  it.each([
    ['optimize', { optimize: true }, THREE],
    ['optimizeFixedOrigin', { optimizeFixedOrigin: true }, THREE],
    ['optimizeFixedDestination', { optimizeFixedDestination: true }, THREE],
    ['isRoundTrip', { isRoundTrip: true }, TWO],
  ])('Google routes: base + waypoint order (%s)', async (_flag, flags, waypoints) => {
    await routeGoogle(flags, waypoints);
    expect(headerOf('X-Goog-FieldMask')).toBe(
      [...GOOGLE_ROUTES_FIELD_MASK, ...GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER].join(','),
    );
  });

  it('Google routes: base + durationWithoutTraffic + waypoint order, in that order', async () => {
    await routeGoogle({ include: ['durationWithoutTraffic'], optimize: true }, THREE);
    expect(headerOf('X-Goog-FieldMask')).toBe(
      [
        ...GOOGLE_ROUTES_FIELD_MASK,
        ...GOOGLE_ROUTES_FIELD_MASK_DURATION_WITHOUT_TRAFFIC,
        ...GOOGLE_ROUTES_FIELD_MASK_WAYPOINT_ORDER,
      ].join(','),
    );
  });

  it('Google matrix', async () => {
    await matrixGoogle();
    expect(headerOf('X-Goog-FieldMask')).toBe(GOOGLE_MATRIX_FIELD_MASK.join(','));
  });

  it('Google place details: base only', async () => {
    await placeDetailsGoogle();
    expect(headerOf('X-Goog-FieldMask')).toBe(GOOGLE_PLACE_DETAILS_FIELD_MASK.join(','));
  });

  it('Google place details: base + name', async () => {
    await placeDetailsGoogle({ include: ['name'] });
    expect(headerOf('X-Goog-FieldMask')).toBe(
      [...GOOGLE_PLACE_DETAILS_FIELD_MASK, ...GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME].join(','),
    );
  });

  it('HERE routing return', async () => {
    await routeHere();
    expect(queryOf().get('return')).toBe(HERE_ROUTING_RETURN.join(','));
  });
});

describe('passthrough: constant + one extra field is sent exactly', () => {
  it('Google routes', async () => {
    const mask = [...GOOGLE_ROUTES_FIELD_MASK, 'routes.travelAdvisory'].join(',');
    const result = await routeGoogle({ _passthrough: { headers: { 'X-Goog-FieldMask': mask } } });
    expect(headerOf('X-Goog-FieldMask')).toBe(mask);
    // The base fields survived, so the normalized outputs are intact.
    expect(result.totalDistanceMeters).toBe(5000);
    expect(result.polyline).toBe('abc');
  });

  it('Google matrix', async () => {
    const mask = [...GOOGLE_MATRIX_FIELD_MASK, 'travelAdvisory'].join(',');
    await matrixGoogle({ _passthrough: { headers: { 'X-Goog-FieldMask': mask } } });
    expect(headerOf('X-Goog-FieldMask')).toBe(mask);
  });

  it('Google place details', async () => {
    const mask = [...GOOGLE_PLACE_DETAILS_FIELD_MASK, 'types'].join(',');
    await placeDetailsGoogle({ _passthrough: { headers: { 'X-Goog-FieldMask': mask } } });
    expect(headerOf('X-Goog-FieldMask')).toBe(mask);
  });

  it('HERE routing', async () => {
    const ret = [...HERE_ROUTING_RETURN, 'turnByTurnActions'].join(',');
    const result = await routeHere({ _passthrough: { query: { return: ret } } });
    expect(queryOf().getAll('return')).toEqual([ret]);
    expect(result.totalDistanceMeters).toBe(5000);
  });
});

describe('passthrough: a caller list REPLACES the default (deliberate)', () => {
  // Replace, not merge: this is what lets a caller drop a default field. Every
  // conditional group is switched on so none of them can leak back in.
  it('Google routes', async () => {
    await routeGoogle(
      {
        include: ['durationWithoutTraffic'],
        optimize: true,
        _passthrough: { headers: { 'X-Goog-FieldMask': 'routes.duration' } },
      },
      THREE,
    );
    expect(headerOf('X-Goog-FieldMask')).toBe('routes.duration');
  });

  it('Google matrix', async () => {
    await matrixGoogle({ _passthrough: { headers: { 'X-Goog-FieldMask': 'duration' } } });
    expect(headerOf('X-Goog-FieldMask')).toBe('duration');
  });

  it('Google place details', async () => {
    await placeDetailsGoogle({
      include: ['name'],
      _passthrough: { headers: { 'X-Goog-FieldMask': 'location' } },
    });
    expect(headerOf('X-Goog-FieldMask')).toBe('location');
  });

  it('HERE routing', async () => {
    await routeHere({ _passthrough: { query: { return: 'polyline' } } });
    expect(queryOf().getAll('return')).toEqual(['polyline']);
  });
});

// --- Body- and query-valued lists: HERE matrixAttributes, Mapbox/OSRM annotations,
// Esri accumulateAttributeNames. Same three properties as above.

const noopSleep = async (): Promise<void> => undefined;

function jsonBodyOf(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

function formOf(): URLSearchParams {
  const [, init] = mockFetch.mock.calls[0]!;
  return new URLSearchParams((init as RequestInit).body as string);
}

function matrixHere(extra: Record<string, unknown> = {}) {
  mockFetch
    .mockResolvedValueOnce(
      resp({ matrixId: 'm1', statusUrl: 'https://matrix.router.hereapi.com/v8/status/m1' }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          matrixId: 'm1',
          status: 'completed',
          resultUrl: 'https://matrix.router.hereapi.com/v8/result/m1',
        }),
        {
          status: 303,
          headers: { Location: 'https://matrix.router.hereapi.com/v8/result/m1' },
        },
      ),
    )
    .mockResolvedValueOnce(
      resp({ matrix: { numOrigins: 1, numDestinations: 1, travelTimes: [60], distances: [900] } }),
    );
  return new HereMatrixConnector({ apiKey: 'k' }, undefined, noopSleep).matrix({
    origins: [TWO[0]!],
    destinations: [TWO[1]!],
    ...extra,
  });
}

const TABLE_BODY = { code: 'Ok', durations: [[60]], distances: [[900]] };
const DURATION_ONLY_TABLE_BODY = { code: 'Ok', durations: [[60]] };

function matrixMapbox(extra: Record<string, unknown> = {}, body: unknown = TABLE_BODY) {
  mockFetch.mockResolvedValueOnce(resp(body));
  return new MapboxMatrixConnector({ accessToken: 'pk' }).matrix({
    origins: [TWO[0]!],
    destinations: [TWO[1]!],
    ...extra,
  });
}

function matrixOsrm(extra: Record<string, unknown> = {}, body: unknown = TABLE_BODY) {
  mockFetch.mockResolvedValueOnce(resp(body));
  return new OsrmMatrixConnector({ baseUrl: 'http://localhost:5000' }).matrix({
    origins: [TWO[0]!],
    destinations: [TWO[1]!],
    ...extra,
  });
}

function routeEsri(extra: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValueOnce(
    resp({
      routes: {
        features: [
          {
            attributes: { Total_TravelTime: 10, Total_Kilometers: 8 },
            geometry: { paths: [[[0, 0], [1, 1]]] },
          },
        ],
      },
      stops: {
        features: [
          { attributes: { Sequence: 1, Status: 0, Cumul_TravelTime: 0, Cumul_Kilometers: 0 } },
          { attributes: { Sequence: 2, Status: 0, Cumul_TravelTime: 10, Cumul_Kilometers: 8 } },
        ],
      },
    }),
  );
  return new EsriRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO, ...extra });
}

function matrixEsri(extra: Record<string, unknown> = {}, costAttributeNames = ['TravelTime', 'Kilometers']) {
  mockFetch.mockResolvedValueOnce(
    resp({ odCostMatrix: { costAttributeNames, '1': { '1': [1, 0.9] } } }),
  );
  return new EsriMatrixConnector({ apiKey: 'k' }).matrix({
    origins: [TWO[0]!],
    destinations: [TWO[1]!],
    ...extra,
  });
}

describe('default wire value equals the published constants (body/query lists)', () => {
  it('HERE matrix matrixAttributes', async () => {
    await matrixHere();
    expect(jsonBodyOf().matrixAttributes).toEqual([...HERE_MATRIX_ATTRIBUTES]);
  });

  it('Mapbox matrix annotations', async () => {
    await matrixMapbox();
    expect(queryOf().get('annotations')).toBe(MAPBOX_MATRIX_ANNOTATIONS.join(','));
  });

  it('OSRM table annotations', async () => {
    await matrixOsrm();
    expect(queryOf().get('annotations')).toBe(OSRM_TABLE_ANNOTATIONS.join(','));
  });

  it('Esri routing accumulateAttributeNames: driving (default mode)', async () => {
    await routeEsri();
    expect(formOf().get('accumulateAttributeNames')).toBe(
      ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING.join(','),
    );
  });

  it('Esri routing accumulateAttributeNames: walking', async () => {
    await routeEsri({ travelMode: 'walking' });
    expect(formOf().get('accumulateAttributeNames')).toBe(
      ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_WALKING.join(','),
    );
  });

  it('Esri matrix accumulateAttributeNames', async () => {
    await matrixEsri();
    expect(formOf().get('accumulateAttributeNames')).toBe(
      ESRI_MATRIX_ACCUMULATE_ATTRIBUTES.join(','),
    );
  });
});

describe('passthrough: constant + one extra value is sent exactly (body lists)', () => {
  it('Esri routing', async () => {
    const list = [...ESRI_ROUTING_ACCUMULATE_ATTRIBUTES_DRIVING, 'Miles'].join(',');
    const result = await routeEsri({ _passthrough: { body: { accumulateAttributeNames: list } } });
    expect(formOf().get('accumulateAttributeNames')).toBe(list);
    expect(result.legs).toEqual([{ distanceMeters: 8000, durationSeconds: 600 }]);
  });

  it('Esri matrix', async () => {
    const list = [...ESRI_MATRIX_ACCUMULATE_ATTRIBUTES, 'Miles'].join(',');
    await matrixEsri(
      { _passthrough: { body: { accumulateAttributeNames: list } } },
      ['TravelTime', 'Kilometers', 'Miles'],
    );
    expect(formOf().get('accumulateAttributeNames')).toBe(list);
  });

  it('HERE matrix', async () => {
    // The body deep-merge replaces arrays, so the spread list is sent as-is. The
    // appended name is a placeholder: this pins the merge, not HERE's vocabulary.
    const list = [...HERE_MATRIX_ATTRIBUTES, 'anotherAttribute'];
    await matrixHere({ _passthrough: { body: { matrixAttributes: list } } });
    expect(jsonBodyOf().matrixAttributes).toEqual(list);
  });
});

describe('passthrough: a caller list REPLACES the default (body/query lists)', () => {
  it('HERE matrix matrixAttributes', async () => {
    await matrixHere({ _passthrough: { body: { matrixAttributes: ['distances'] } } }).catch(
      () => undefined,
    );
    expect(jsonBodyOf().matrixAttributes).toEqual(['distances']);
  });

  // Mapbox and OSRM document only `duration` and `distance` for these endpoints,
  // so there is no extra value to append — only replacement to pin: they are
  // ordinary replaceable defaults.
  it.each([
    ['Mapbox', matrixMapbox],
    ['OSRM', matrixOsrm],
  ])('%s annotations: a caller list is sent verbatim', async (_p, run) => {
    await run({ _passthrough: { query: { annotations: 'distance,duration' } } });
    expect(queryOf().getAll('annotations')).toEqual(['distance,duration']);
  });

  it.each([
    ['Mapbox', matrixMapbox],
    ['OSRM', matrixOsrm],
  ])('%s annotations without distance: the call raises unknown, never zeroed cells', async (_p, run) => {
    const err = await run(
      { _passthrough: { query: { annotations: 'duration' } } },
      DURATION_ONLY_TABLE_BODY,
    ).catch((e: unknown) => e);
    expect(queryOf().getAll('annotations')).toEqual(['duration']);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).providerCode).toBe('unknown');
  });

  it('Esri routing', async () => {
    await routeEsri({
      travelMode: 'walking',
      _passthrough: { body: { accumulateAttributeNames: 'WalkTime' } },
    });
    expect(formOf().getAll('accumulateAttributeNames')).toEqual(['WalkTime']);
  });

  it('Esri matrix: dropping Kilometers raises unknown rather than reporting 0 m', async () => {
    const err = await matrixEsri(
      { _passthrough: { body: { accumulateAttributeNames: 'Miles' } } },
      ['TravelTime', 'Miles'],
    ).catch((e: unknown) => e);
    expect(formOf().getAll('accumulateAttributeNames')).toEqual(['Miles']);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).providerCode).toBe('unknown');
  });
});
