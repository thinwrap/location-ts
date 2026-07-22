import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Matrix } from './matrix.facade';
import type { IMatrixOptions, MatrixOptionsFor } from '../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildGoogleMatrixResponse() {
  return new Response(
    JSON.stringify([
      { originIndex: 0, destinationIndex: 0, distanceMeters: 1000, duration: '60s', staticDuration: '60s', condition: 'ROUTE_EXISTS' },
    ]),
    { status: 200 }
  );
}

function buildOsrmTableResponse() {
  return new Response(
    JSON.stringify({
      code: 'Ok',
      durations: [[0, 120]],
      distances: [[0, 2000]],
    }),
    { status: 200 }
  );
}

const origins = [{ lat: 40.7128, lng: -74.006 }];
const destinations = [{ lat: 40.758, lng: -73.9855 }];

describe('Matrix (unified facade)', () => {
  it('should create a Google matrix connector and delegate matrix()', async () => {
    mockFetch.mockResolvedValueOnce(buildGoogleMatrixResponse());

    const matrix = new Matrix('google', { apiKey: 'gk' });
    expect(matrix.providerId).toBe('google');

    const result = await matrix.matrix({ origins, destinations });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.distanceMeters).toBe(1000);
  });

  it('should create an OSRM matrix connector and delegate matrix()', async () => {
    mockFetch.mockResolvedValueOnce(buildOsrmTableResponse());

    const matrix = new Matrix('osrm', { baseUrl: 'http://localhost:5000' });
    expect(matrix.providerId).toBe('osrm');

    const result = await matrix.matrix({ origins, destinations });

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.durationSeconds).toBe(0);
  });

  it('should create Mapbox, HERE, ESRI, and TomTom matrix connectors', () => {
    expect(new Matrix('mapbox', { accessToken: 'pk' }).providerId).toBe('mapbox');
    expect(new Matrix('here', { apiKey: 'hk' }).providerId).toBe('here');
    expect(new Matrix('esri', { apiKey: 'ek' }).providerId).toBe('esri');
    expect(new Matrix('tomtom', { apiKey: 'tk' }).providerId).toBe('tomtom');
  });

  it('should throw on unknown provider', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new Matrix('unknown' as any, {} as any)
    ).toThrow('Unknown matrix provider: unknown');
  });

  it('uses the injected fetchImpl when one is supplied to the facade', async () => {
    const customFetch = vi.fn().mockResolvedValue(buildGoogleMatrixResponse());
    const matrix = new Matrix('google', { apiKey: 'gk' }, customFetch);
    await matrix.matrix({ origins, destinations });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Matrix facade — type-level narrowing tests', () => {
  // 7a. Positive narrowing — one per provider; constructor type-checks with the
  // correct config shape, and `providerId` literal-narrows to the requested id.
  it('accepts GoogleConfig for new Matrix("google", ...)', () => {
    const m = new Matrix('google', { apiKey: 'k' });
    expect(m.providerId).toBe('google');
  });

  it('accepts MapboxConfig for new Matrix("mapbox", ...)', () => {
    const m = new Matrix('mapbox', { accessToken: 'pk.xxx' });
    expect(m.providerId).toBe('mapbox');
  });

  it('accepts HereConfig for new Matrix("here", ...)', () => {
    const m = new Matrix('here', { apiKey: 'hk' });
    expect(m.providerId).toBe('here');
  });

  it('accepts EsriConfig for new Matrix("esri", ...)', () => {
    const m = new Matrix('esri', { apiKey: 'ek' });
    expect(m.providerId).toBe('esri');
  });

  it('accepts OsrmConfig for new Matrix("osrm", ...)', () => {
    const m = new Matrix('osrm', { baseUrl: 'http://localhost:5000' });
    expect(m.providerId).toBe('osrm');
  });

  it('accepts TomTomConfig for new Matrix("tomtom", ...)', () => {
    const m = new Matrix('tomtom', { apiKey: 'tk' });
    expect(m.providerId).toBe('tomtom');
  });

  // 7b. Negative narrowing — wrong config shape produces @ts-expect-error.
  it('rejects MapboxConfig for new Matrix("google", ...) at compile time', () => {
    // @ts-expect-error MapboxConfig (`accessToken`) is not assignable to GoogleConfig (`apiKey`).
    const _m = new Matrix('google', { accessToken: 'pk.xxx' });
    void _m;
    expect(true).toBe(true);
  });

  it('rejects GoogleConfig for new Matrix("mapbox", ...) at compile time', () => {
    // @ts-expect-error GoogleConfig (`apiKey`) is not assignable to MapboxConfig (`accessToken`).
    const _m = new Matrix('mapbox', { apiKey: 'k' });
    void _m;
    expect(true).toBe(true);
  });

  it('rejects passing fetchImpl as second arg (config required) at compile time', () => {
    // Compile-time-only assertion: wrap in an unreachable factory so we don't
    // execute the runtime path (which would just construct against fetch).
    const _factory = () =>
      // @ts-expect-error config is required (second positional); fetch is not a valid config.
      new Matrix('google', globalThis.fetch);
    void _factory;
    expect(true).toBe(true);
  });

  it('rejects unknown provider id at compile time', () => {
    // Compile-time-only assertion: wrap in an unreachable factory so we don't
    // execute the runtime path (which would throw "Unknown matrix provider").
    const _factory = () =>
      // @ts-expect-error 'not-a-provider' is not a MatrixProvider.
      new Matrix('not-a-provider', { apiKey: 'k' });
    void _factory;
    expect(true).toBe(true);
  });

  // 7c. `MatrixOptionsFor<P>` resolves to `IMatrixOptions` at v1.0 (no augmentations yet).
  it('MatrixOptionsFor<P> resolves to IMatrixOptions when P has not augmented', () => {
    const _m = new Matrix('google', { apiKey: 'k' });
    // The facade's `.matrix()` parameter accepts the full base `IMatrixOptions` shape:
    const input: Parameters<typeof _m.matrix>[0] = {
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
      travelMode: 'driving',
      avoidTolls: true,
      departureTime: new Date(),
      _passthrough: { body: { foo: 'bar' }, headers: { 'X-Trace': 't' }, query: { q: '1' } },
    };
    void input;
    expect(true).toBe(true);
  });

  it('MatrixOptionsFor<"google"> is structurally compatible with IMatrixOptions at v1.0', () => {
    // Compile-time assertion: an `IMatrixOptions` value is assignable to
    // `MatrixOptionsFor<'google'>` and vice versa (the conditional falls back
    // to `IMatrixOptions` because the empty base `MatrixOptionsMap` has no
    // `'google'` key).
    const base: IMatrixOptions = {
      origins: [{ lat: 0, lng: 0 }],
      destinations: [{ lat: 1, lng: 1 }],
    };
    const narrowed: MatrixOptionsFor<'google'> = base;
    const baseFromNarrowed: IMatrixOptions = narrowed;
    void baseFromNarrowed;
    expect(true).toBe(true);
  });
});
