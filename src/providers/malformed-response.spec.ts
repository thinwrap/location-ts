import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorError } from '../types';
import { EsriGeocodingConnector } from './esri/esri.geocoding.connector';
import { GoogleGeocodingConnector } from './google/google.geocoding.connector';
import { HereGeocodingConnector } from './here/here.geocoding.connector';
import { HereIsochroneConnector } from './here/here.isochrone.connector';
import { MapboxGeocodingConnector } from './mapbox/mapbox.geocoding.connector';
import { TomTomGeocodingConnector } from './tomtom/tomtom.geocoding.connector';
import { TomTomIsochroneConnector } from './tomtom/tomtom.isochrone.connector';

/**
 * Cross-provider contract for 2xx bodies the connector cannot interpret.
 *
 * A well-formed "zero results" answer stays an empty result; anything else a
 * connector cannot read — a list that is not a list, a null row — is either
 * skipped (a single unusable row among good ones) or raised as `unknown` with
 * the body on `cause`. It never escapes as a raw `TypeError` and never becomes
 * data the provider did not send.
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

const google = () => new GoogleGeocodingConnector({ apiKey: 'k' });
const here = () => new HereGeocodingConnector({ apiKey: 'k' });
const mapbox = () => new MapboxGeocodingConnector({ accessToken: 'pk' });
const tomtom = () => new TomTomGeocodingConnector({ apiKey: 'k' });
const esri = () => new EsriGeocodingConnector({ apiKey: 'k' });

describe('geocode — the result list', () => {
  it.each([
    ['Google', () => google().geocode({ address: 'x' }), { status: 'OK', results: { a: 1 } }],
    ['HERE', () => here().geocode({ address: 'x' }), { items: 'nope' }],
    ['Mapbox', () => mapbox().geocode({ address: 'x' }), { features: {} }],
    ['TomTom', () => tomtom().geocode({ address: 'x' }), { results: 7 }],
    ['Esri', () => esri().geocode({ address: 'x' }), { candidates: 'nope' }],
  ])('%s raises unknown for a list that is not a list', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const err = (await run().catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.providerCode).toBe('unknown');
    expect(err.statusCode).toBe(200);
    expect(err.cause).toEqual(body);
  });

  it.each([
    [
      'Google',
      () => google().geocode({ address: 'x' }),
      {
        status: 'OK',
        results: [null, { formatted_address: 'a', geometry: { location: { lat: 1, lng: 2 } } }],
      },
    ],
    [
      'HERE',
      () => here().geocode({ address: 'x' }),
      { items: [null, { address: { label: 'a' }, position: { lat: 1, lng: 2 } }] },
    ],
    [
      'Mapbox',
      () => mapbox().geocode({ address: 'x' }),
      { features: [null, { geometry: { coordinates: [2, 1] }, properties: { full_address: 'a' } }] },
    ],
    [
      'TomTom',
      () => tomtom().geocode({ address: 'x' }),
      { results: [null, { address: { freeformAddress: 'a' }, position: { lat: 1, lon: 2 } }] },
    ],
    [
      'Esri',
      () => esri().geocode({ address: 'x' }),
      { candidates: [null, { address: 'a', location: { x: 2, y: 1 } }] },
    ],
  ])('%s skips a null row and keeps the good one', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const result = await run();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.location).toEqual({ lat: 1, lng: 2 });
  });

  it.each([
    ['Google', () => google().geocode({ address: 'x' }), { status: 'ZERO_RESULTS', results: [] }],
    ['HERE', () => here().geocode({ address: 'x' }), { items: [] }],
    ['Mapbox', () => mapbox().geocode({ address: 'x' }), { features: [] }],
    ['TomTom', () => tomtom().geocode({ address: 'x' }), { results: [] }],
    ['Esri', () => esri().geocode({ address: 'x' }), { candidates: [] }],
  ])('%s keeps a well-formed zero-results answer an empty result', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    await expect(run()).resolves.toMatchObject({ candidates: [] });
  });
});

describe('reverse geocode and autocomplete rows', () => {
  it('TomTom skips a null reverse-geocode entry', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ addresses: [null, { address: { freeformAddress: 'a' }, position: '1,2' }] }),
    );
    const result = await tomtom().reverseGeocode({ location: { lat: 1, lng: 2 } });
    expect(result.candidates).toEqual([{ formattedAddress: 'a', location: { lat: 1, lng: 2 } }]);
  });

  it.each([
    [
      'Google',
      () => google().autocomplete({ input: 'x' }),
      { suggestions: [null, { placePrediction: { placeId: 'p', text: { text: 'a' } } }] },
    ],
    ['HERE', () => here().autocomplete({ input: 'x', location: { lat: 1, lng: 2 } }), { items: [null, { title: 'a', id: 'p' }] }],
    ['Mapbox', () => mapbox().autocomplete({ input: 'x' }), { suggestions: [null, { name: 'a', mapbox_id: 'p' }] }],
    // A TomTom row with neither a POI name nor an address has nothing to show.
    [
      'TomTom',
      () => tomtom().autocomplete({ input: 'x' }),
      { results: [null, { id: 'q' }, { id: 'p', address: { freeformAddress: 'a' } }] },
    ],
    ['Esri', () => esri().autocomplete({ input: 'x' }), { suggestions: [null, { text: 'a', magicKey: 'p' }] }],
  ])('%s autocomplete skips unusable rows', async (_p, run, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const result = await run();
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]).toMatchObject({ description: 'a', placeId: 'p' });
  });

  it.each([
    ['Google', () => google().autocomplete({ input: 'x' }), new Response('', { status: 200 })],
    ['Google', () => google().autocomplete({ input: 'x' }), resp({ suggestions: 'nope' })],
    ['Mapbox', () => mapbox().autocomplete({ input: 'x' }), resp({ suggestions: {} })],
    ['TomTom', () => tomtom().autocomplete({ input: 'x' }), resp({ results: 'nope' })],
    ['Esri', () => esri().autocomplete({ input: 'x' }), resp({ suggestions: 'nope' })],
  ])('%s autocomplete raises unknown for an unreadable body', async (_p, run, response) => {
    mockFetch.mockResolvedValueOnce(response);
    await expect(run()).rejects.toMatchObject({ providerCode: 'unknown' });
  });
});

describe('viewports', () => {
  // A (0,0) corner would silently stretch a consumer's map bounds.
  it('Esri drops a partial extent rather than 0-filling it', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        candidates: [{ address: 'a', location: { x: 2, y: 1 }, extent: { xmin: 1, ymin: 0.5 } }],
      }),
    );
    const result = await esri().geocode({ address: 'x' });
    expect(result.candidates[0]!.viewport).toBeUndefined();
  });

  it('Mapbox drops a bbox that is not a list of four numbers', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        features: [
          { geometry: { coordinates: [2, 1] }, properties: { full_address: 'a', bbox: 'abcd' } },
        ],
      }),
    );
    const result = await mapbox().geocode({ address: 'x' });
    expect(result.candidates[0]!.viewport).toBeUndefined();
  });
});

describe('Esri reverse geocode with no address nearby', () => {
  // ESRI answers a location with nothing nearby with an `error` body rather
  // than an empty result; it is "no result", not the caller's bad request.
  it('returns empty candidates for "Unable to find address"', async () => {
    const body = {
      error: {
        code: 400,
        extendedCode: -2147467259,
        message: 'Cannot perform query. Invalid query parameters.',
        details: ['Unable to find address for the specified location.'],
      },
    };
    mockFetch.mockResolvedValueOnce(resp(body));
    const result = await esri().reverseGeocode({ location: { lat: 0, lng: -30 } });
    expect(result).toEqual({ candidates: [], raw: body });
  });

  it('still raises for other 400 error bodies', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ error: { code: 400, message: 'Invalid location', details: [] } }),
    );
    await expect(
      esri().reverseGeocode({ location: { lat: 0, lng: -30 } }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
  });
});

describe('isochrone bodies without a usable polygon', () => {
  it.each([
    ['no isolines', { isolines: [] }],
    ['an isoline without polygons', { isolines: [{ range: { value: 600 } }] }],
    ['an isoline without a range value', { isolines: [{ polygons: [{ outer: 'BFoz5xJ67i1B1B7PzIhaxL7Y' }] }] }],
    ['a null isoline', { isolines: [null] }],
  ])('HERE raises unknown for %s', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    await expect(
      new HereIsochroneConnector({ apiKey: 'k' }).isochrone({
        center: { lat: 1, lng: 2 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
  });

  it.each([
    ['an empty boundary', { reachableRange: { boundary: [] } }],
    ['a point missing longitude', { reachableRange: { boundary: [{ latitude: 1 }] } }],
    ['a null point', { reachableRange: { boundary: [null] } }],
  ])('TomTom raises unknown for %s', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    await expect(
      new TomTomIsochroneConnector({ apiKey: 'k' }).isochrone({
        center: { lat: 1, lng: 2 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'unknown', statusCode: 200 });
  });

  it('HERE sends range values in plain decimal notation', async () => {
    mockFetch.mockResolvedValueOnce(resp({ isolines: [] }));
    await new HereIsochroneConnector({ apiKey: 'k' })
      .isochrone({ center: { lat: 1, lng: 2 }, type: 'distance', values: [1e21] })
      .catch(() => undefined);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(new URLSearchParams(url.split('?')[1]).get('range[values]')).toBe(
      '1000000000000000000000',
    );
  });
});
