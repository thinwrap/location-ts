import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriGeocodingConnector } from './esri/esri.geocoding.connector';
import { GoogleGeocodingConnector } from './google/google.geocoding.connector';
import { HereGeocodingConnector } from './here/here.geocoding.connector';
import { MapboxGeocodingConnector } from './mapbox/mapbox.geocoding.connector';
import { TomTomGeocodingConnector } from './tomtom/tomtom.geocoding.connector';

/**
 * Cross-provider contract for `IAutocompletePrediction.structuredFormat`.
 *
 * The field exists so a UI can render the usual two-line suggestion without
 * splitting `description` on the first comma — a workaround that breaks on names
 * containing commas and on locales that order the address differently.
 *
 * The load-bearing assertions here are the **negative** ones. `structuredFormat`
 * is never synthesized, so every case where a provider has no distinct main part
 * must leave it absent rather than fabricate one.
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

describe('structuredFormat — providers that supply distinct parts', () => {
  it('Google reads structuredFormat.mainText / .secondaryText', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        suggestions: [
          {
            placePrediction: {
              placeId: 'p1',
              text: { text: 'Blue Bottle Coffee, 66 Mint St, San Francisco' },
              structuredFormat: {
                mainText: { text: 'Blue Bottle Coffee' },
                secondaryText: { text: '66 Mint St, San Francisco' },
              },
            },
          },
        ],
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'blue bottle',
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({
      mainText: 'Blue Bottle Coffee',
      secondaryText: '66 Mint St, San Francisco',
    });
    // `description` is unchanged — the new field is additive.
    expect(result.predictions[0]!.description).toBe(
      'Blue Bottle Coffee, 66 Mint St, San Francisco',
    );
  });

  it('Mapbox reads name / place_formatted', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        suggestions: [
          {
            name: 'Blue Bottle Coffee',
            place_formatted: '66 Mint St, San Francisco, CA',
            full_address: 'Blue Bottle Coffee, 66 Mint St, San Francisco, CA',
            mapbox_id: 'id1',
          },
        ],
      }),
    );

    const result = await new MapboxGeocodingConnector({ accessToken: 'pk' }).autocomplete({
      input: 'blue bottle',
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({
      mainText: 'Blue Bottle Coffee',
      secondaryText: '66 Mint St, San Francisco, CA',
    });
  });

  it('HERE reads title / address.label', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        items: [
          {
            title: 'Brandenburger Tor',
            id: 'here:1',
            address: { label: 'Pariser Platz, 10117 Berlin, Germany' },
          },
        ],
      }),
    );

    const result = await new HereGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'brandenburger',
      // Autosuggest mandates a search context; irrelevant to what this asserts.
      location: { lat: 52.52, lng: 13.405 },
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({
      mainText: 'Brandenburger Tor',
      secondaryText: 'Pariser Platz, 10117 Berlin, Germany',
    });
  });

  it('TomTom reads poi.name / address.freeformAddress', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        results: [
          {
            id: 'tt1',
            poi: { name: 'Rijksmuseum' },
            address: { freeformAddress: 'Museumstraat 1, 1071 XX Amsterdam' },
          },
        ],
      }),
    );

    const result = await new TomTomGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'rijks',
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({
      mainText: 'Rijksmuseum',
      secondaryText: 'Museumstraat 1, 1071 XX Amsterdam',
    });
  });
});

describe('structuredFormat — omitted rather than synthesized', () => {
  // Live-verified: TomTom street/address results have no `poi.name`. Splitting
  // `freeformAddress` on a comma to invent a main part would be a guess.
  it('TomTom omits it for a street result with no poi.name', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        results: [
          { id: 'tt2', address: { freeformAddress: 'Museumstraat 1, Amsterdam' } },
        ],
      }),
    );

    const result = await new TomTomGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'museumstraat',
    });

    expect(result.predictions[0]!.structuredFormat).toBeUndefined();
    // `description` still carries the full text for rendering.
    expect(result.predictions[0]!.description).toBe('Museumstraat 1, Amsterdam');
  });

  // HERE's *query*-type suggestions have a title but no address at all.
  it('HERE emits mainText only when the item has no address', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ items: [{ title: 'pizza', id: 'here:q:1' }] }),
    );

    const result = await new HereGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'pizza',
      // Autosuggest mandates a search context; irrelevant to what this asserts.
      location: { lat: 52.52, lng: 13.405 },
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({ mainText: 'pizza' });
    expect(result.predictions[0]!.structuredFormat?.secondaryText).toBeUndefined();
  });

  it('Mapbox emits mainText only when place_formatted is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ suggestions: [{ name: 'Blue Bottle', mapbox_id: 'id1' }] }),
    );

    const result = await new MapboxGeocodingConnector({ accessToken: 'pk' }).autocomplete({
      input: 'blue',
    });

    expect(result.predictions[0]!.structuredFormat).toEqual({ mainText: 'Blue Bottle' });
  });

  it('Google omits it entirely when the vendor sends no structuredFormat', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        suggestions: [{ placePrediction: { placeId: 'p1', text: { text: 'Somewhere' } } }],
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'some',
    });

    expect(result.predictions[0]!.structuredFormat).toBeUndefined();
    expect(result.predictions[0]!.description).toBe('Somewhere');
  });

  it('Google omits it when mainText is present but empty', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        suggestions: [
          {
            placePrediction: {
              placeId: 'p1',
              text: { text: 'Somewhere' },
              structuredFormat: { mainText: { text: '' } },
            },
          },
        ],
      }),
    );

    const result = await new GoogleGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'some',
    });

    expect(result.predictions[0]!.structuredFormat).toBeUndefined();
  });

  // Esri returns a single flat `text` field — the genuine gap. It must stay
  // absent rather than be faked by splitting that string.
  it('Esri never emits it', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        suggestions: [
          { text: 'Rijksmuseum, Museumstraat 1, Amsterdam', magicKey: 'mk1' },
        ],
      }),
    );

    const result = await new EsriGeocodingConnector({ apiKey: 'k' }).autocomplete({
      input: 'rijks',
    });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]!.structuredFormat).toBeUndefined();
    expect(result.predictions[0]!.description).toBe(
      'Rijksmuseum, Museumstraat 1, Amsterdam',
    );
  });
});
