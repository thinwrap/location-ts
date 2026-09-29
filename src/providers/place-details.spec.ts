import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Geocoding } from '../facades/geocoding.facade';
import { ConnectorError } from '../types';
import { EsriGeocodingConnector } from './esri/esri.geocoding.connector';
import { GoogleGeocodingConnector } from './google/google.geocoding.connector';
import { HereGeocodingConnector } from './here/here.geocoding.connector';
import { MapboxGeocodingConnector } from './mapbox/mapbox.geocoding.connector';
import { TomTomGeocodingConnector } from './tomtom/tomtom.geocoding.connector';

/**
 * Cross-provider contract for `placeDetails`.
 *
 * One operation, not two: "place details" and "geocode by place id" are the same
 * vendor call on all five providers, so the result is a full `IGeocodeCandidate`
 * rather than a new shape.
 *
 * Every endpoint here was live-probed before implementation. The Esri case is the
 * one worth reading twice: the docs pair `magicKey` with the original search text,
 * and probing showed the key alone resolves to the byte-identical candidate — so
 * `placeId` needs no companion field.
 */

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function resp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function urlOf(i = 0): string {
  return mockFetch.mock.calls[i]![0] as string;
}

function queryOf(i = 0): URLSearchParams {
  return new URLSearchParams(urlOf(i).split('?')[1] ?? '');
}

function headerOf(name: string, i = 0): string | undefined {
  const [, init] = mockFetch.mock.calls[i]!;
  return ((init as RequestInit).headers as Record<string, string>)[name];
}

describe('placeDetails — endpoints and normalization', () => {
  it('Google GETs /v1/places/{id} and maps the candidate', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        id: 'ChIJ1',
        formattedAddress: '66 Mint St, San Francisco, CA 94103, USA',
        location: { latitude: 37.7825, longitude: -122.4059 },
        viewport: {
          low: { latitude: 37.78, longitude: -122.41 },
          high: { latitude: 37.79, longitude: -122.4 },
        },
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'ChIJ1',
    });

    expect(urlOf()).toContain('https://places.googleapis.com/v1/places/ChIJ1');
    expect(result.candidate!.location).toEqual({ lat: 37.7825, lng: -122.4059 });
    expect(result.candidate!.placeId).toBe('ChIJ1');
    expect(result.candidate!.viewport).toEqual({
      southwest: { lat: 37.78, lng: -122.41 },
      northeast: { lat: 37.79, lng: -122.4 },
    });
  });

  it('HERE GETs /v1/lookup?id=', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        title: 'Brandenburger Tor',
        id: 'here:pds:place:1',
        address: { label: 'Pariser Platz, 10117 Berlin' },
        position: { lat: 52.5163, lng: 13.3777 },
      }),
    );

    const result = await new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'here:pds:place:1',
    });

    expect(urlOf()).toContain('https://lookup.search.hereapi.com/v1/lookup');
    expect(queryOf().get('id')).toBe('here:pds:place:1');
    expect(result.candidate!.location).toEqual({ lat: 52.5163, lng: 13.3777 });
    // The address is `address.label`; the POI title is the place's name.
    expect(result.candidate!.formattedAddress).toBe('Pariser Platz, 10117 Berlin');
  });

  it('HERE lookup puts the title in name and address.label in formattedAddress', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        title: 'Empire State Building',
        id: 'here:pds:place:esb',
        address: {
          label: 'Empire State Building, 20 W 34th St, New York, NY 10118, United States',
        },
        position: { lat: 40.74844, lng: -73.98566 },
      }),
    );

    const result = await new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'here:pds:place:esb',
      include: ['name'],
    });

    expect(result.name).toBe('Empire State Building');
    expect(result.candidate!.formattedAddress).toBe(
      'Empire State Building, 20 W 34th St, New York, NY 10118, United States',
    );
  });

  it('Mapbox GETs /searchbox/v1/retrieve/{id}', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          {
            geometry: { coordinates: [-122.4059, 37.7825] },
            properties: {
              mapbox_id: 'mb1',
              full_address: '66 Mint St, San Francisco',
              name: 'Blue Bottle Coffee',
            },
          },
        ],
      }),
    );

    const result = await new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
      placeId: 'mb1',
    });

    expect(urlOf()).toContain(
      'https://api.mapbox.com/search/searchbox/v1/retrieve/mb1',
    );
    expect(result.candidate!.location).toEqual({ lat: 37.7825, lng: -122.4059 });
  });

  // Google and Mapbox both bill Autocomplete/Search Box PER SESSION, closed by
  // the details call carrying the SAME token. The two vendors spell it
  // differently on the wire, which is exactly why it is a narrowed per-provider
  // input rather than a base option.
  it('Google sends sessionToken as a query param on Place Details', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        id: 'g1',
        formattedAddress: 'Dizengoff St 50, Tel Aviv-Yafo, Israel',
        location: { latitude: 32.0797, longitude: 34.7738 },
      }),
    );

    await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'g1',
      sessionToken: '3f2a1c58-9b4e-4d7a-8e21-6c5f0b7d9a34',
    });

    expect(urlOf()).toContain('sessionToken=3f2a1c58-9b4e-4d7a-8e21-6c5f0b7d9a34');
  });

  it('Mapbox sends the same concept as session_token', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          {
            geometry: { coordinates: [-122.4059, 37.7825] },
            properties: { mapbox_id: 'mb1', full_address: '66 Mint St' },
          },
        ],
      }),
    );

    await new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
      placeId: 'mb1',
      sessionToken: 'shared-token',
    });

    expect(urlOf()).toContain('session_token=shared-token');
  });

  it('omits the token entirely when none is passed', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ id: 'g1', formattedAddress: 'x', location: { latitude: 1, longitude: 2 } }),
    );
    await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'g1' });
    expect(urlOf()).not.toContain('sessionToken');
  });

  it('TomTom GETs /search/2/place.json?entityId=', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        results: [
          {
            id: 'tt1',
            address: { freeformAddress: 'Museumstraat 1, Amsterdam' },
            position: { lat: 52.36, lon: 4.885 },
          },
        ],
      }),
    );

    const result = await new TomTomGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'tt1',
    });

    expect(urlOf()).toContain('https://api.tomtom.com/search/2/place.json');
    expect(queryOf().get('entityId')).toBe('tt1');
    expect(result.candidate!.location).toEqual({ lat: 52.36, lng: 4.885 });
  });

  // Live-verified: magicKey ALONE resolves. The docs pair it with SingleLine; the
  // probe showed that is unnecessary, which is why there is no Esri narrowed input.
  it('Esri sends magicKey alone, with no companion search text', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        candidates: [
          {
            address: 'Museumstraat 1, Amsterdam',
            location: { x: 4.885, y: 52.36 },
          },
        ],
      }),
    );

    const result = await new EsriGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'mk-abc',
    });

    const q = queryOf();
    expect(q.get('magicKey')).toBe('mk-abc');
    expect(q.has('SingleLine')).toBe(false);
    expect(result.candidate!.location).toEqual({ lat: 52.36, lng: 4.885 });
  });
});

describe('placeDetails — the `name` opt-in', () => {
  // Google's Place Details SKU tier is driven by the FIELD MASK (displayName is
  // Pro), the opposite of Compute Routes, whose SKU is feature-driven.
  it('Google omits displayName from the field mask by default', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        id: 'p1',
        formattedAddress: 'somewhere',
        location: { latitude: 1, longitude: 2 },
        displayName: { text: 'Blue Bottle' },
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'p1',
    });

    expect(headerOf('X-Goog-FieldMask')).not.toContain('displayName');
    // Not surfaced even though this fixture carries it.
    expect(result.name).toBeUndefined();
  });

  it('Google requests and surfaces displayName when included', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        id: 'p1',
        formattedAddress: 'somewhere',
        location: { latitude: 1, longitude: 2 },
        displayName: { text: 'Blue Bottle' },
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'p1',
      include: ['name'],
    });

    expect(headerOf('X-Goog-FieldMask')).toContain('displayName');
    expect(result.name).toBe('Blue Bottle');
  });

  it.each([
    [
      'HERE',
      () =>
        new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({
          placeId: 'h1',
          include: ['name'],
        }),
      {
        title: 'Brandenburger Tor',
        id: 'h1',
        address: { label: 'Berlin' },
        position: { lat: 1, lng: 2 },
      },
      'Brandenburger Tor',
    ],
    [
      'Mapbox',
      () =>
        new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
          placeId: 'mb1',
          include: ['name'],
        }),
      {
        features: [
          {
            geometry: { coordinates: [2, 1] },
            properties: { mapbox_id: 'mb1', full_address: 'x', name: 'Blue Bottle' },
          },
        ],
      },
      'Blue Bottle',
    ],
    [
      'TomTom',
      () =>
        new TomTomGeocodingConnector({ apiKey: 'k' }).placeDetails({
          placeId: 'tt1',
          include: ['name'],
        }),
      {
        results: [
          {
            id: 'tt1',
            poi: { name: 'Rijksmuseum' },
            address: { freeformAddress: 'Amsterdam' },
            position: { lat: 1, lon: 2 },
          },
        ],
      },
      'Rijksmuseum',
    ],
  ])('%s surfaces name when included', async (_p, run, body, expected) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const result = await run();
    expect(result.name).toBe(expected);
  });

  // Esri returns only an address — there is no display name to surface, so `name`
  // stays absent even when asked for. Absence is information, not a bug.
  it('Esri leaves name absent even when included', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ candidates: [{ address: 'Amsterdam', location: { x: 2, y: 1 } }] }),
    );

    const result = await new EsriGeocodingConnector({ apiKey: 'k' }).placeDetails({
      placeId: 'mk1',
      include: ['name'],
    });

    expect(result.name).toBeUndefined();
    expect(result.candidate!.formattedAddress).toBe('Amsterdam');
  });
});

describe('placeDetails — Mapbox session billing', () => {
  // Search Box bills per SESSION: suggest + retrieve with the SAME token is one
  // billable session. `session_token` is REQUIRED on /retrieve, so a missing
  // token is replaced by a generated UUIDv4 (a session of its own).
  it('forwards sessionToken as session_token', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          { geometry: { coordinates: [2, 1] }, properties: { mapbox_id: 'mb1' } },
        ],
      }),
    );

    await new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
      placeId: 'mb1',
      sessionToken: 'sess-123',
    });

    expect(queryOf().get('session_token')).toBe('sess-123');
  });

  it('sends a generated UUIDv4 session_token when none is given', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          { geometry: { coordinates: [2, 1] }, properties: { mapbox_id: 'mb1' } },
        ],
      }),
    );

    await new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
      placeId: 'mb1',
    });

    expect(queryOf().get('session_token')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('lets _passthrough.query.session_token win over the typed sessionToken', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          { geometry: { coordinates: [2, 1] }, properties: { mapbox_id: 'mb1' } },
        ],
      }),
    );

    await new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({
      placeId: 'mb1',
      sessionToken: 'typed',
      _passthrough: { query: { session_token: 'from-passthrough' } },
    });

    expect(queryOf().get('session_token')).toBe('from-passthrough');
  });
});

describe('placeDetails — no usable result', () => {
  // A place id that no longer resolves (places close, ids expire) is an answer,
  // not a failure: the candidate is null — never a fabricated (0,0) — and `raw`
  // still carries what the vendor said.
  it.each([
    [
      'Google (place without a location)',
      () =>
        new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'p', include: ['name'] }),
      resp({ id: 'p', formattedAddress: 'x', displayName: { text: 'Gone' } }),
    ],
    [
      'Google (404 NOT_FOUND)',
      () => new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'p' }),
      resp({ error: { code: 404, message: 'Place not found', status: 'NOT_FOUND' } }, 404),
    ],
    [
      'HERE (item without a position)',
      () =>
        new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'h', include: ['name'] }),
      resp({ title: 'x', id: 'h' }),
    ],
    [
      'HERE (lookup 404)',
      () => new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'h' }),
      resp({ status: 404, title: 'Requested id could not be found.' }, 404),
    ],
    [
      'Mapbox (no feature)',
      () =>
        new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({ placeId: 'm' }),
      resp({ features: [] }),
    ],
    [
      'Mapbox (feature without coordinates)',
      () =>
        new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({ placeId: 'm', include: ['name'] }),
      resp({ features: [{ properties: { mapbox_id: 'm', name: 'Gone' } }] }),
    ],
    [
      'TomTom (no result)',
      () => new TomTomGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 't' }),
      resp({ results: [] }),
    ],
    [
      'Esri (no candidate)',
      () => new EsriGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'e' }),
      resp({ candidates: [] }),
    ],
    [
      'Mapbox (retrieve 404)',
      () =>
        new MapboxGeocodingConnector({ accessToken: 'pk' }).placeDetails({ placeId: 'm' }),
      resp({ message: { error: 'No data found for requested ID' } }, 404),
    ],
  ])('%s returns a null candidate with the vendor body in raw', async (_p, run, response) => {
    const body = (await response.clone().json()) as unknown;
    mockFetch.mockResolvedValueOnce(response);

    const result = await run();

    expect(result.candidate).toBeNull();
    expect(result.name).toBeUndefined();
    expect(result.raw).toEqual(body);
  });

  // A malformed id the vendor rejects as invalid is still the caller's mistake.
  it.each([
    [
      'Google 400 INVALID_ARGUMENT',
      () => new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'bad' }),
      resp({ error: { code: 400, message: 'Not a valid Place ID: bad', status: 'INVALID_ARGUMENT' } }, 400),
    ],
    [
      'HERE 400',
      () => new HereGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'bad' }),
      resp({ status: 400, title: 'Illegal input for parameter id' }, 400),
    ],
    // Live: Places v1 answers a well-formed but unknown id with this too.
    [
      'Google 400 "not valid" for an unknown id',
      () => new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'ChIJunknown' }),
      resp({ error: { code: 400, message: 'The provided Place ID: ChIJunknown is not valid.', status: 'INVALID_ARGUMENT' } }, 400),
    ],
    [
      'Esri magicKey from an earlier release',
      () => new EsriGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'stale' }),
      resp({
        error: {
          code: 400,
          message: 'Unable to complete operation.',
          details: ['MagicKey was not generated from the current release and is no longer valid'],
        },
      }),
    ],
    [
      'Esri invalid magicKey',
      () => new EsriGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'bad' }),
      resp({
        error: {
          code: 400,
          message: 'Unable to complete operation.',
          details: ['magicKey entered is invalid'],
        },
      }),
    ],
  ])('%s stays invalid_request', async (_p, run, response) => {
    mockFetch.mockResolvedValueOnce(response);
    await expect(run()).rejects.toMatchObject({ providerCode: 'invalid_request' });
  });

  it('a Google 404 without a Places envelope is still "not found"', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 'p' });
    expect(result.candidate).toBeNull();
  });

  it('an unparseable 2xx body stays an unknown error rather than "not found"', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(
      new TomTomGeocodingConnector({ apiKey: 'k' }).placeDetails({ placeId: 't' }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe('placeDetails — facade', () => {
  it('dispatches through the Geocoding facade', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        id: 'p1',
        formattedAddress: 'somewhere',
        location: { latitude: 1, longitude: 2 },
      }),
    );

    const geocoding = new Geocoding('google', { apiKey: 'k' });
    const result = await geocoding.placeDetails({ placeId: 'p1' });

    expect(result.candidate!.location).toEqual({ lat: 1, lng: 2 });
  });

  // The `placeDetails?` optionality on IGeocodingConnector exists so adding the
  // operation stays a MINOR for bring-your-own-connector implementers. The facade's
  // provider-union constraint keeps that from becoming a runtime footgun; this
  // covers the only way past it — a custom connector injected around the types.
  it('raises unsupported_option for a connector that does not implement it', async () => {
    const geocoding = new Geocoding('google', { apiKey: 'k' });
    // A bring-your-own connector that predates the operation: it satisfies
    // IGeocodingConnector (placeDetails is optional) but has no implementation.
    // Swapping the whole object matters — `delete` would be a no-op, since the
    // real method lives on the prototype rather than as an own property.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geocoding as any).connector = {
      providerId: 'google',
      geocode: vi.fn(),
      reverseGeocode: vi.fn(),
      autocomplete: vi.fn(),
    };

    await expect(geocoding.placeDetails({ placeId: 'p1' })).rejects.toMatchObject({
      providerCode: 'unsupported_option',
    });
  });
});
