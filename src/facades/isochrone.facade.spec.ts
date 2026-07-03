import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Isochrone } from './isochrone.facade';
import type {
  IIsochroneOptions,
  IsochroneOptionsFor,
} from '../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildMapboxIsochroneResponse() {
  return new Response(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          properties: { contour: 10, metric: 'time' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-74.006, 40.71], [-73.99, 40.72], [-74.006, 40.71]]],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

describe('Isochrone (unified facade)', () => {
  it('should create a Mapbox isochrone connector and delegate isochrone()', async () => {
    mockFetch.mockResolvedValueOnce(buildMapboxIsochroneResponse());

    const iso = new Isochrone('mapbox', { accessToken: 'pk.xxx' });
    expect(iso.providerId).toBe('mapbox');

    const result = await iso.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.contours).toHaveLength(1);
    // contour `value` is normalized back to seconds (matches
    // input unit). Mapbox returns `contour=10` (minutes) → 600 seconds.
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
  });

  it('should create HERE, ESRI, and TomTom isochrone connectors', () => {
    expect(new Isochrone('here', { apiKey: 'hk' }).providerId).toBe('here');
    expect(new Isochrone('esri', { apiKey: 'ek' }).providerId).toBe('esri');
    expect(new Isochrone('tomtom', { apiKey: 'tk' }).providerId).toBe('tomtom');
  });

  it('should throw on unknown provider', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new Isochrone('unknown' as any, {} as any)
    ).toThrow('Unknown isochrone provider: unknown');
  });

  it('uses the injected fetchImpl when one is supplied to the facade', async () => {
    const customFetch = vi.fn().mockResolvedValue(buildMapboxIsochroneResponse());
    const iso = new Isochrone('mapbox', { accessToken: 'pk.xxx' }, customFetch);
    await iso.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600],
    });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Isochrone facade — type-level narrowing tests', () => {
  // 8a. Base `travelMode` narrowed to `'driving' | 'walking'`.
  it('IsochroneOptionsFor<P> resolves to IIsochroneOptions when P has not augmented', () => {
    const _i = new Isochrone('here', { apiKey: 'hk' });
    const input: Parameters<typeof _i.isochrone>[0] = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300, 600],
      travelMode: 'driving',
      departureTime: '2026-05-17T12:00:00Z',
    };
    void input;
    expect(true).toBe(true);
  });

  // 8b. Mapbox augmentation: cycling type-checks for Mapbox.
  it('accepts travelMode: "cycling" for new Isochrone("mapbox",...)', () => {
    const _i = new Isochrone('mapbox', { accessToken: 'pk' });
    const input: Parameters<typeof _i.isochrone>[0] = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'cycling',
    };
    void _i;
    void input;
    expect(true).toBe(true);
  });

  // 8c. TomTom augmentation: cycling type-checks for TomTom.
  it('accepts travelMode: "cycling" for new Isochrone("tomtom",...)', () => {
    const _i = new Isochrone('tomtom', { apiKey: 'tk' });
    const input: Parameters<typeof _i.isochrone>[0] = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'cycling',
    };
    void _i;
    void input;
    expect(true).toBe(true);
  });

  // 8d. HERE stays narrowed at base — cycling is `@ts-expect-error` because
  // HERE has not augmented IsochroneOptionsMap.
  it('rejects travelMode: "cycling" for new Isochrone("here", ...) at compile time', () => {
    const _i = new Isochrone('here', { apiKey: 'hk' });
    const _input: Parameters<typeof _i.isochrone>[0] = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      // @ts-expect-error HERE has no cycling support (only Mapbox + TomTom augment).
      travelMode: 'cycling',
    };
    void _i;
    void _input;
    expect(true).toBe(true);
  });

  // 8e. ESRI stays narrowed at base — same as HERE.
  it('rejects travelMode: "cycling" for new Isochrone("esri", ...) at compile time', () => {
    const _i = new Isochrone('esri', { apiKey: 'ek' });
    const _input: Parameters<typeof _i.isochrone>[0] = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      // @ts-expect-error ESRI has no cycling support (only Mapbox + TomTom augment).
      travelMode: 'cycling',
    };
    void _i;
    void _input;
    expect(true).toBe(true);
  });

  // 8f. Negative narrowing: Google + OSRM are not IsochroneProviders.
  it('rejects Google (not an IsochroneProvider) at compile time', () => {
    const _factory = () =>
      // @ts-expect-error 'google' is not an IsochroneProvider.
      new Isochrone('google', { apiKey: 'gk' });
    void _factory;
    expect(true).toBe(true);
  });

  it('rejects OSRM (not an IsochroneProvider) at compile time', () => {
    const _factory = () =>
      // @ts-expect-error 'osrm' is not an IsochroneProvider.
      new Isochrone('osrm', { baseUrl: 'http://localhost:5000' });
    void _factory;
    expect(true).toBe(true);
  });

  // 8g. Structural compatibility: base options assignable to per-provider
  // resolved type at v1.0 (no narrowing breakages).
  it('IsochroneOptionsFor<"here"> is structurally compatible with IIsochroneOptions', () => {
    const base: IIsochroneOptions = {
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
    };
    const narrowed: IsochroneOptionsFor<'here'> = base;
    const baseFromNarrowed: IIsochroneOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });
});
