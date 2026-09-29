/**
 * The error contract, pinned in one place.
 *
 * 1. Operation failures are `ConnectorError`, including request DATA the library
 *    rejects before sending (non-finite coordinates, too few waypoints, empty
 *    origins, bad breaks, an invalid `Date`, …) and capability rejections
 *    (`unsupported_*`): a rejection with `statusCode: null`.
 * 2. API MISUSE is a native `TypeError` and never a `ConnectorError`: an unknown
 *    provider or a missing config (thrown by the facade constructor), a value
 *    outside a closed vocabulary or a wrong argument type (rejected by the
 *    operation).
 *
 * Every row runs with zero `fetch` calls. Every `TypeError` row also asserts it
 * is NOT a `ConnectorError`, so a later "helpful" wrap cannot silently flip the
 * rule: consumers treat `invalid_request` as bad end-user input, so a wrapped
 * bug would be blamed on end users instead of alerting.
 *
 * Adding a connector or a closed vocabulary means adding its rows here.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { ConnectorError } from './types';
import type {
  IAutocompleteOptions,
  IIsochroneOptions,
  IMatrixOptions,
  IPlaceDetailsOptions,
  IRoutingOptions,
  PlaceDetailsInclude,
  PolylineQuality,
  ProviderCode,
  RoutingInclude,
  TrafficMode,
} from './types';
import type {
  ISOCHRONE_TYPES,
  PLACE_DETAILS_INCLUDE_TOKENS,
  POLYLINE_QUALITIES,
  ROUTING_INCLUDE_TOKENS,
  TRAFFIC_MODES,
  TRAVEL_MODES,
} from './utils/assert-one-of';
import { Routing } from './facades/routing.facade';
import { Matrix } from './facades/matrix.facade';
import { Geocoding } from './facades/geocoding.facade';
import { Isochrone } from './facades/isochrone.facade';
import {
  GoogleRoutingConnector,
  GoogleMatrixConnector,
  GoogleGeocodingConnector,
} from './providers/google';
import {
  MapboxRoutingConnector,
  MapboxMatrixConnector,
  MapboxGeocodingConnector,
  MapboxIsochroneConnector,
} from './providers/mapbox';
import {
  HereRoutingConnector,
  HereMatrixConnector,
  HereGeocodingConnector,
  HereIsochroneConnector,
} from './providers/here';
import {
  EsriRoutingConnector,
  EsriMatrixConnector,
  EsriGeocodingConnector,
  EsriIsochroneConnector,
} from './providers/esri';
import { OsrmRoutingConnector, OsrmMatrixConnector } from './providers/osrm';
import {
  TomTomRoutingConnector,
  TomTomMatrixConnector,
  TomTomGeocodingConnector,
  TomTomIsochroneConnector,
} from './providers/tomtom';

type Expected = { kind: 'TypeError' } | { kind: 'ConnectorError'; code: ProviderCode };

const TYPE_ERROR: Expected = { kind: 'TypeError' };
const ce = (code: ProviderCode): Expected => ({ kind: 'ConnectorError', code });

function unreachableFetch() {
  return vi.fn(async () => {
    throw new Error('fetch must not be called for a pre-flight failure');
  });
}

type FetchMock = ReturnType<typeof unreachableFetch>;

/**
 * Run an operation and assert the contract: it REJECTS (never throws
 * synchronously), with the expected kind, and never touches the network.
 */
async function expectRejection(
  run: (fetchImpl: typeof fetch) => Promise<unknown>,
  expected: Expected,
): Promise<void> {
  const fetchMock: FetchMock = unreachableFetch();
  let promise: Promise<unknown>;
  try {
    promise = run(fetchMock as unknown as typeof fetch);
  } catch (syncError) {
    throw new Error(`expected a rejection, got a synchronous throw: ${String(syncError)}`);
  }
  const error = await promise.then(
    () => {
      throw new Error('expected the operation to reject');
    },
    (e: unknown) => e,
  );
  assertKind(error, expected);
  expect(fetchMock).not.toHaveBeenCalled();
}

function assertKind(error: unknown, expected: Expected): void {
  if (expected.kind === 'TypeError') {
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectorError);
  } else {
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ providerCode: expected.code, statusCode: null });
  }
}

const A = { lat: 40.7128, lng: -74.006 };
const B = { lat: 41.4173, lng: -73.0001 };

// The runtime vocabularies must list exactly the members of the public unions:
// a member added to a type but not to its array would reject a valid value.
describe('error contract — vocabularies match the public types', () => {
  it('each vocabulary array equals its union (checked by the typecheck)', () => {
    expectTypeOf<(typeof TRAVEL_MODES)[number]>().toEqualTypeOf<
      NonNullable<IRoutingOptions['travelMode']>
    >();
    expectTypeOf<(typeof TRAVEL_MODES)[number]>().toEqualTypeOf<
      NonNullable<IMatrixOptions['travelMode']>
    >();
    expectTypeOf<(typeof TRAFFIC_MODES)[number]>().toEqualTypeOf<TrafficMode>();
    expectTypeOf<(typeof POLYLINE_QUALITIES)[number]>().toEqualTypeOf<PolylineQuality>();
    expectTypeOf<(typeof ROUTING_INCLUDE_TOKENS)[number]>().toEqualTypeOf<RoutingInclude>();
    expectTypeOf<(typeof PLACE_DETAILS_INCLUDE_TOKENS)[number]>().toEqualTypeOf<PlaceDetailsInclude>();
    expectTypeOf<(typeof ISOCHRONE_TYPES)[number]>().toEqualTypeOf<IIsochroneOptions['type']>();
  });
});

// ---------------------------------------------------------------------------
// Routing — every connector
// ---------------------------------------------------------------------------

type RoutingFactory = (fetchImpl: typeof fetch) => { route(o: IRoutingOptions): Promise<unknown> };

const routingConnectors: Array<[string, RoutingFactory]> = [
  ['google', (f) => new GoogleRoutingConnector({ apiKey: 'k' }, f)],
  ['mapbox', (f) => new MapboxRoutingConnector({ accessToken: 'pk.x' }, f)],
  ['here', (f) => new HereRoutingConnector({ apiKey: 'k' }, f)],
  ['esri', (f) => new EsriRoutingConnector({ apiKey: 'k' }, f)],
  ['osrm', (f) => new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }, f)],
  ['tomtom', (f) => new TomTomRoutingConnector({ apiKey: 'k' }, f)],
];

const routingCases: Array<[string, Record<string, unknown>, Expected]> = [
  ['an unknown travelMode', { travelMode: 'flying' }, TYPE_ERROR],
  ['a null travelMode', { travelMode: null }, TYPE_ERROR],
  ['an unknown trafficMode', { trafficMode: 'realtime' }, TYPE_ERROR],
  ['an unknown polylineQuality', { polylineQuality: 'ultra' }, TYPE_ERROR],
  ['an unknown include token', { include: ['bogus'] }, TYPE_ERROR],
  ['a non-array include', { include: 'durationWithoutTraffic' }, TYPE_ERROR],
  ['a string departureTime', { departureTime: '2026-01-01T00:00:00Z' }, TYPE_ERROR],
  ['an epoch-number departureTime', { departureTime: 1767225600000 }, TYPE_ERROR],
  ['an invalid Date', { departureTime: new Date('garbage') }, ce('invalid_request')],
  [
    'an invalid Date with traffic',
    { departureTime: new Date('garbage'), trafficMode: 'traffic' },
    ce('invalid_request'),
  ],
  ['a single waypoint', { waypoints: [A] }, ce('invalid_request')],
  ['a NaN waypoint', { waypoints: [A, { lat: NaN, lng: 0 }] }, ce('invalid_request')],
];

describe('error contract — routing', () => {
  describe.each(routingConnectors)('%s', (_provider, create) => {
    it.each(routingCases)('%s', async (_label, patch, expected) => {
      await expectRejection(
        (f) => create(f).route({ waypoints: [A, B], ...patch } as IRoutingOptions),
        expected,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Matrix — every connector
// ---------------------------------------------------------------------------

type MatrixFactory = (fetchImpl: typeof fetch) => { matrix(o: IMatrixOptions): Promise<unknown> };

const matrixConnectors: Array<[string, MatrixFactory]> = [
  ['google', (f) => new GoogleMatrixConnector({ apiKey: 'k' }, f)],
  ['mapbox', (f) => new MapboxMatrixConnector({ accessToken: 'pk.x' }, f)],
  ['here', (f) => new HereMatrixConnector({ apiKey: 'k' }, f)],
  ['esri', (f) => new EsriMatrixConnector({ apiKey: 'k' }, f)],
  ['osrm', (f) => new OsrmMatrixConnector({ baseUrl: 'http://localhost:5000' }, f)],
  ['tomtom', (f) => new TomTomMatrixConnector({ apiKey: 'k' }, f)],
];

const matrixCases: Array<[string, Record<string, unknown>, Expected]> = [
  ['an unknown travelMode', { travelMode: 'flying' }, TYPE_ERROR],
  ['an unknown trafficMode', { trafficMode: 'realtime' }, TYPE_ERROR],
  ['a string departureTime', { departureTime: '2026-01-01T00:00:00Z' }, TYPE_ERROR],
  ['an invalid Date', { departureTime: new Date('garbage') }, ce('invalid_request')],
  ['empty origins', { origins: [] }, ce('invalid_request')],
  ['empty destinations', { destinations: [] }, ce('invalid_request')],
  ['a NaN origin', { origins: [{ lat: NaN, lng: 0 }] }, ce('invalid_request')],
];

describe('error contract — matrix', () => {
  describe.each(matrixConnectors)('%s', (_provider, create) => {
    it.each(matrixCases)('%s', async (_label, patch, expected) => {
      await expectRejection(
        (f) => create(f).matrix({ origins: [A], destinations: [B], ...patch } as IMatrixOptions),
        expected,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Isochrone — every connector
// ---------------------------------------------------------------------------

type IsochroneFactory = (fetchImpl: typeof fetch) => {
  isochrone(o: IIsochroneOptions): Promise<unknown>;
};

const isochroneConnectors: Array<[string, IsochroneFactory, { cycling: Expected | null }]> = [
  // Mapbox supports cycling isochrones, so it has no capability row.
  ['mapbox', (f) => new MapboxIsochroneConnector({ accessToken: 'pk.x' }, f), { cycling: null }],
  ['here', (f) => new HereIsochroneConnector({ apiKey: 'k' }, f), { cycling: ce('unsupported_travel_mode') }],
  ['esri', (f) => new EsriIsochroneConnector({ apiKey: 'k' }, f), { cycling: ce('unsupported_travel_mode') }],
  ['tomtom', (f) => new TomTomIsochroneConnector({ apiKey: 'k' }, f), { cycling: ce('unsupported_travel_mode') }],
];

const isochroneCases: Array<[string, Record<string, unknown>, Expected]> = [
  ['an unknown type', { type: 'volume' }, TYPE_ERROR],
  ['a missing type', { type: undefined }, TYPE_ERROR],
  ['an unknown travelMode', { travelMode: 'flying' }, TYPE_ERROR],
  ['a Date departureTime', { departureTime: new Date('2026-01-01T00:00:00Z') }, TYPE_ERROR],
  ['an unparseable departureTime', { departureTime: 'tomorrow-ish' }, ce('invalid_request')],
  ['no break values', { values: [] }, ce('invalid_request')],
  ['a non-positive break', { values: [0] }, ce('invalid_request')],
  ['five break values', { values: [60, 120, 180, 240, 300] }, ce('invalid_request')],
];

describe('error contract — isochrone', () => {
  describe.each(isochroneConnectors)('%s', (_provider, create, capability) => {
    const run = (patch: Record<string, unknown>) => (f: typeof fetch) =>
      create(f).isochrone({ center: A, type: 'time', values: [600], ...patch } as IIsochroneOptions);

    it.each(isochroneCases)('%s', async (_label, patch, expected) => {
      await expectRejection(run(patch), expected);
    });

    if (capability.cycling !== null) {
      const expected = capability.cycling;
      it('cycling is a capability rejection, not a vocabulary error', async () => {
        await expectRejection(run({ travelMode: 'cycling' }), expected);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Geocoding — placeDetails include tokens, autocomplete radius
// ---------------------------------------------------------------------------

type PlaceDetailsFactory = (fetchImpl: typeof fetch) => {
  placeDetails(o: IPlaceDetailsOptions): Promise<unknown>;
};

const placeDetailsConnectors: Array<[string, PlaceDetailsFactory]> = [
  ['google', (f) => new GoogleGeocodingConnector({ apiKey: 'k' }, f)],
  ['mapbox', (f) => new MapboxGeocodingConnector({ accessToken: 'pk.x' }, f)],
  ['here', (f) => new HereGeocodingConnector({ apiKey: 'k' }, f)],
  ['esri', (f) => new EsriGeocodingConnector({ apiKey: 'k' }, f)],
  ['tomtom', (f) => new TomTomGeocodingConnector({ apiKey: 'k' }, f)],
];

describe('error contract — placeDetails', () => {
  describe.each(placeDetailsConnectors)('%s', (_provider, create) => {
    it.each([
      ['an unknown include token', { include: ['phone'] }],
      ['a non-array include', { include: 'name' }],
    ])('%s', async (_label, patch) => {
      await expectRejection(
        (f) => create(f).placeDetails({ placeId: 'p1', ...patch } as IPlaceDetailsOptions),
        TYPE_ERROR,
      );
    });
  });
});

type AutocompleteFactory = (fetchImpl: typeof fetch) => {
  autocomplete(o: IAutocompleteOptions): Promise<unknown>;
};

// Mapbox and Esri document `radius` as ignored, so it is never sent there.
const radiusConnectors: Array<[string, AutocompleteFactory]> = [
  ['google', (f) => new GoogleGeocodingConnector({ apiKey: 'k' }, f)],
  ['here', (f) => new HereGeocodingConnector({ apiKey: 'k' }, f)],
  ['tomtom', (f) => new TomTomGeocodingConnector({ apiKey: 'k' }, f)],
];

describe('error contract — autocomplete radius', () => {
  describe.each(radiusConnectors)('%s', (_provider, create) => {
    it.each([
      ['a NaN radius', NaN, ce('invalid_request')],
      ['an infinite radius', Infinity, ce('invalid_request')],
      ['a string radius', '500', TYPE_ERROR],
    ] as Array<[string, unknown, Expected]>)('%s', async (_label, radius, expected) => {
      await expectRejection(
        (f) =>
          create(f).autocomplete({ input: 'pizza', location: A, radius } as IAutocompleteOptions),
        expected,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Credentials and config data (call time, ConnectorError)
// ---------------------------------------------------------------------------

describe('error contract — config data checked at call time', () => {
  it.each([
    ['neither credential', {}, ce('auth_failed')],
    ['both credentials', { apiKey: 'k', arcgisToken: 't' }, ce('invalid_request')],
  ] as Array<[string, object, Expected]>)('Esri with %s', async (_label, config, expected) => {
    await expectRejection(
      (f) => new EsriRoutingConnector(config, f).route({ waypoints: [A, B] }),
      expected,
    );
  });

  it.each([
    ['an empty baseUrl', { baseUrl: '' }],
    ['a schemeless baseUrl', { baseUrl: 'localhost:5000' }],
  ])('OSRM with %s', async (_label, config) => {
    await expectRejection(
      (f) => new OsrmRoutingConnector(config, f).route({ waypoints: [A, B] }),
      ce('invalid_request'),
    );
  });

  // Direct connector construction keeps its call-time check; only the facades
  // reject a missing config at construction.
  it('a direct OSRM connector with a null config rejects with invalid_request', async () => {
    await expectRejection(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f) => new OsrmRoutingConnector(null as any, f).route({ waypoints: [A, B] }),
      ce('invalid_request'),
    );
  });
});

// ---------------------------------------------------------------------------
// Facade construction — synchronous TypeError
// ---------------------------------------------------------------------------

type FacadeFactory = (provider: string, config: unknown) => unknown;

const facades: Array<[string, FacadeFactory, string]> = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ['Routing', (p, c) => new Routing(p as any, c as any), 'google'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ['Matrix', (p, c) => new Matrix(p as any, c as any), 'osrm'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ['Geocoding', (p, c) => new Geocoding(p as any, c as any), 'esri'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ['Isochrone', (p, c) => new Isochrone(p as any, c as any), 'here'],
];

describe('error contract — facade construction', () => {
  describe.each(facades)('%s', (_name, create, validProvider) => {
    it.each([
      ['an unknown provider', 'bogus', { apiKey: 'k' }],
      ['a Symbol provider', Symbol('x'), { apiKey: 'k' }],
      ['a null config', validProvider, null],
      ['an undefined config', validProvider, undefined],
      ['a string config', validProvider, 'k'],
    ] as Array<[string, unknown, unknown]>)('throws a TypeError for %s', (_label, provider, config) => {
      let error: unknown;
      try {
        create(provider as string, config);
      } catch (e) {
        error = e;
      }
      assertKind(error, TYPE_ERROR);
    });
  });

  it('a provider without the operation is a TypeError', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const create = () => new Isochrone('google' as any, { apiKey: 'k' } as any);
    expect(create).toThrow(TypeError);
    expect(create).toThrow('Unknown isochrone provider: google');
  });

  it('a facade operation rejects (it does not throw synchronously) for misuse', async () => {
    const fetchMock = unreachableFetch();
    const routing = new Routing('google', { apiKey: 'k' }, fetchMock as unknown as typeof fetch);
    const pending = routing.route({
      waypoints: [A, B],
      travelMode: 'flying' as IRoutingOptions['travelMode'],
    });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
