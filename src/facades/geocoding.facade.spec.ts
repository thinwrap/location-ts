import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Geocoding } from './geocoding.facade';
import type {
  IGeocodeOptions,
  IReverseGeocodeOptions,
  IAutocompleteOptions,
  GeocodeOptionsFor,
  ReverseGeocodeOptionsFor,
  AutocompleteOptionsFor,
} from '../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildGoogleGeocodeResponse() {
  return new Response(
    JSON.stringify({
      status: 'OK',
      results: [
        {
          formatted_address: '1600 Amphitheatre Parkway',
          geometry: { location: { lat: 37.42, lng: -122.08 } },
          place_id: 'place1',
        },
      ],
    }),
    { status: 200 }
  );
}

function buildGoogleAutocompleteResponse() {
  // migrated the Google connector to the Places Autocomplete NEW
  // response shape (`suggestions[].placePrediction.text.text` + `.placeId`).
  return new Response(
    JSON.stringify({
      suggestions: [
        {
          placePrediction: {
            placeId: 'ny1',
            text: { text: 'New York, NY' },
          },
        },
      ],
    }),
    { status: 200 }
  );
}

describe('Geocoding (unified facade)', () => {
  it('should create a Google geocoding connector and delegate geocode()', async () => {
    mockFetch.mockResolvedValueOnce(buildGoogleGeocodeResponse());

    const geo = new Geocoding('google', { apiKey: 'gk' });
    expect(geo.providerId).toBe('google');

    const result = await geo.geocode({ address: '1600 Amphitheatre' });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.location).toEqual({ lat: 37.42, lng: -122.08 });
  });

  it('should delegate reverseGeocode and return candidates[] shape', async () => {
    mockFetch.mockResolvedValueOnce(buildGoogleGeocodeResponse());

    const geo = new Geocoding('google', { apiKey: 'gk' });
    const result = await geo.reverseGeocode({ location: { lat: 37.42, lng: -122.08 } });

    // reverse-geocode mirrors forward shape (`candidates[]`), not a
    // single `formattedAddress` field.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.formattedAddress).toBe('1600 Amphitheatre Parkway');
  });

  it('should delegate autocomplete()', async () => {
    mockFetch.mockResolvedValueOnce(buildGoogleAutocompleteResponse());

    const geo = new Geocoding('google', { apiKey: 'gk' });
    const result = await geo.autocomplete({ input: 'New York' });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]!.description).toBe('New York, NY');
  });

  it('should create Mapbox, HERE, ESRI, and TomTom geocoding connectors', () => {
    expect(new Geocoding('mapbox', { accessToken: 'pk' }).providerId).toBe('mapbox');
    expect(new Geocoding('here', { apiKey: 'hk' }).providerId).toBe('here');
    expect(new Geocoding('esri', { apiKey: 'ek' }).providerId).toBe('esri');
    expect(new Geocoding('tomtom', { apiKey: 'tk' }).providerId).toBe('tomtom');
  });

  it('should throw on unknown provider', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new Geocoding('unknown' as any, {} as any)
    ).toThrow('Unknown geocoding provider: unknown');
  });

  it('uses the injected fetchImpl when one is supplied to the facade', async () => {
    const customFetch = vi.fn().mockResolvedValue(buildGoogleGeocodeResponse());
    const geo = new Geocoding('google', { apiKey: 'gk' }, customFetch);
    await geo.geocode({ address: '1600 Amphitheatre' });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Geocoding facade — type-level narrowing tests', () => {
  // 7a. Positive narrowing — one per provider; constructor type-checks with
  // the correct config shape, and `providerId` literal-narrows to the
  // requested id.
  it('accepts GoogleConfig for new Geocoding("google", ...)', () => {
    const g = new Geocoding('google', { apiKey: 'k' });
    expect(g.providerId).toBe('google');
  });

  it('accepts MapboxConfig for new Geocoding("mapbox", ...)', () => {
    const g = new Geocoding('mapbox', { accessToken: 'pk.xxx' });
    expect(g.providerId).toBe('mapbox');
  });

  it('accepts HereConfig for new Geocoding("here", ...)', () => {
    const g = new Geocoding('here', { apiKey: 'hk' });
    expect(g.providerId).toBe('here');
  });

  it('accepts EsriConfig for new Geocoding("esri", ...)', () => {
    const g = new Geocoding('esri', { apiKey: 'ek' });
    expect(g.providerId).toBe('esri');
  });

  it('accepts TomTomConfig for new Geocoding("tomtom", ...)', () => {
    const g = new Geocoding('tomtom', { apiKey: 'tk' });
    expect(g.providerId).toBe('tomtom');
  });

  // 7b. Negative narrowing — wrong config shape produces @ts-expect-error.
  it('rejects MapboxConfig for new Geocoding("google", ...) at compile time', () => {
    // @ts-expect-error MapboxConfig (`accessToken`) is not assignable to GoogleConfig (`apiKey`).
    const _g = new Geocoding('google', { accessToken: 'pk.xxx' });
    void _g;
    expect(true).toBe(true);
  });

  it('rejects GoogleConfig for new Geocoding("mapbox", ...) at compile time', () => {
    // @ts-expect-error GoogleConfig (`apiKey`) is not assignable to MapboxConfig (`accessToken`).
    const _g = new Geocoding('mapbox', { apiKey: 'k' });
    void _g;
    expect(true).toBe(true);
  });

  it('rejects OSRM (not a GeocodingProvider) at compile time', () => {
    // excludes OSRM from Geocoding — `'osrm'` is not assignable to
    // `GeocodingProvider`. Wrap in an unreachable factory to keep the
    // assertion compile-time-only.
    const _factory = () =>
      // @ts-expect-error 'osrm' is not a GeocodingProvider.
      new Geocoding('osrm', { baseUrl: 'http://localhost:5000' });
    void _factory;
    expect(true).toBe(true);
  });

  it('rejects passing fetchImpl as second arg (config required) at compile time', () => {
    const _factory = () =>
      // @ts-expect-error config is required (second positional); fetch is not a valid config.
      new Geocoding('google', globalThis.fetch);
    void _factory;
    expect(true).toBe(true);
  });

  it('rejects unknown provider id at compile time', () => {
    const _factory = () =>
      // @ts-expect-error 'novu' is not a GeocodingProvider.
      new Geocoding('novu', { apiKey: 'k' });
    void _factory;
    expect(true).toBe(true);
  });

  // 7c. `<Op>OptionsFor<P>` resolves to base option types at v1.0 (no
  // augmentations yet) — one assertion per method.
  it('GeocodeOptionsFor<P> resolves to IGeocodeOptions when P has not augmented', () => {
    const _g = new Geocoding('google', { apiKey: 'k' });
    const input: Parameters<typeof _g.geocode>[0] = {
      address: '1 Infinite Loop',
      language: 'en',
      countryFilter: ['US', 'CA'],
      _passthrough: { body: { foo: 'bar' }, headers: { 'X-Trace': 't' }, query: { q: '1' } },
    };
    void input;
    expect(true).toBe(true);
  });

  it('ReverseGeocodeOptionsFor<P> resolves to IReverseGeocodeOptions when P has not augmented', () => {
    const _g = new Geocoding('google', { apiKey: 'k' });
    const input: Parameters<typeof _g.reverseGeocode>[0] = {
      location: { lat: 0, lng: 0 },
      language: 'en',
    };
    void input;
    expect(true).toBe(true);
  });

  it('AutocompleteOptionsFor<P> resolves to IAutocompleteOptions when P has not augmented', () => {
    const _g = new Geocoding('google', { apiKey: 'k' });
    const input: Parameters<typeof _g.autocomplete>[0] = {
      input: 'New',
      location: { lat: 0, lng: 0 },
      radius: 1000,
      language: 'en',
    };
    void input;
    expect(true).toBe(true);
  });

  it('GeocodeOptionsFor<"google"> is structurally compatible with IGeocodeOptions at v1.0', () => {
    const base: IGeocodeOptions = { address: '1 Main St' };
    const narrowed: GeocodeOptionsFor<'google'> = base;
    const baseFromNarrowed: IGeocodeOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });

  it('ReverseGeocodeOptionsFor<"mapbox"> is structurally compatible with IReverseGeocodeOptions at v1.0', () => {
    const base: IReverseGeocodeOptions = { location: { lat: 0, lng: 0 } };
    const narrowed: ReverseGeocodeOptionsFor<'mapbox'> = base;
    const baseFromNarrowed: IReverseGeocodeOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });

  it('AutocompleteOptionsFor<"here"> is structurally compatible with IAutocompleteOptions at v1.0', () => {
    const base: IAutocompleteOptions = { input: 'x' };
    const narrowed: AutocompleteOptionsFor<'here'> = base;
    const baseFromNarrowed: IAutocompleteOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });
});
