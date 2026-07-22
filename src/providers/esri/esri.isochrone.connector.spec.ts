import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EsriIsochroneConnector } from './esri.isochrone.connector';
import type { EsriConfig } from './esri.config';
import { ConnectorError } from '../../types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: EsriConfig = { apiKey: 'esri-test-token' };

function buildServiceAreaResponse() {
  return new Response(
    JSON.stringify({
      saPolygons: {
        features: [
          {
            attributes: { FromBreak: 10, ToBreak: 20 },
            geometry: {
              rings: [[[-74.02, 40.70], [-73.98, 40.73], [-74.02, 40.70]]],
            },
          },
          {
            attributes: { FromBreak: 0, ToBreak: 10 },
            geometry: {
              rings: [[[-74.006, 40.7128], [-73.99, 40.72], [-74.006, 40.7128]]],
            },
          },
        ],
      },
    }),
    { status: 200 },
  );
}

describe('EsriIsochroneConnector', () => {
  let connector: EsriIsochroneConnector;

  beforeEach(() => {
    connector = new EsriIsochroneConnector(defaultConfig);
  });

  it('should have providerId "esri"', () => {
    expect(connector.providerId).toBe('esri');
  });

  it('should POST form-encoded ServiceArea with time breaks in minutes', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    const result = await connector.isochrone({
      center: { lat: 40.7128, lng: -74.006 },
      type: 'time',
      values: [600, 1200], // 10min, 20min in seconds
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain('solveServiceArea');
    expect(url as string).toContain('route-api.arcgis.com');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toContain(
      'application/x-www-form-urlencoded',
    );

    const params = new URLSearchParams(init!.body as string);
    expect(params.get('f')).toBe('json');
    expect(params.get('token')).toBe('esri-test-token');
    expect(params.get('defaultBreaks')).toBe('10,20');
    expect(params.get('breakUnits')).toBe('esriDriveTimeUnitsMinutes');
    expect(params.get('travelDirection')).toBe('esriNATravelDirectionFromFacility');

    const facilities = JSON.parse(params.get('facilities')!);
    expect(facilities.features[0].geometry.x).toBe(-74.006);
    expect(facilities.features[0].geometry.y).toBe(40.7128);
    expect(facilities.features[0].geometry.spatialReference.wkid).toBe(4326);

    // Contours sorted ascending and converted back to seconds.
    expect(result.contours).toHaveLength(2);
    expect(result.contours[0]!.value).toBe(600);
    expect(result.contours[1]!.value).toBe(1200);
    expect(result.contours[0]!.geometry.type).toBe('Polygon');
    expect((result.contours[0]!.geometry as { coordinates: number[][][] }).coordinates[0]).toEqual([
      [-74.006, 40.7128],
      [-73.99, 40.72],
      [-74.006, 40.7128],
    ]);
  });

  it('should pass distance values through as meters with esriDriveDistanceUnitsMeters', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'distance',
      values: [1000, 2000],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('defaultBreaks')).toBe('1000,2000');
    expect(params.get('breakUnits')).toBe('esriDriveDistanceUnitsMeters');
  });

  it('should pass the full Walking Time travelMode JSON object for walking', async () => {
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
      travelMode: 'walking',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    // ArcGIS requires a full travel-mode JSON object, not a name string
    // (a bare "Walking Time" is ignored and the service stays on driving).
    const travelMode = JSON.parse(params.get('travelMode') as string);
    expect(travelMode.type).toBe('WALK');
    expect(travelMode.impedanceAttributeName).toBe('WalkTime');
    expect(travelMode.name).toBe('Walking Time');
  });

  it('should accept arcgisToken alternative auth (dual-auth XOR)', async () => {
    const tokenConn = new EsriIsochroneConnector({ arcgisToken: 'oauth-token' });
    mockFetch.mockResolvedValueOnce(buildServiceAreaResponse());

    await tokenConn.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [600],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const params = new URLSearchParams(init!.body as string);
    expect(params.get('token')).toBe('oauth-token');
  });

  it('should throw on dual-auth XOR violation (both set)', async () => {
    const badConn = new EsriIsochroneConnector({
      apiKey: 'k',
      arcgisToken: 't',
    });

    await expect(
      badConn.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should enforce the 4-value cap', async () => {
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [60, 120, 180, 240, 300],
      }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should throw ConnectorError on 200 with error body (ESRI quirk)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Token invalid', code: 498 },
        }),
        { status: 200 },
      ),
    );

    let caught: unknown;
    try {
      await connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    const e = caught as ConnectorError;
    expect(e.providerCode).toBe('auth_failed');
    expect(e.providerMessage).toContain('Token invalid');
  });

  it('should throw ConnectorError on transport error (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }),
    );

    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'provider_unavailable' });
  });

  // Esri 429-precedence regression: a genuine HTTP 429 must classify as
  // rate_limited EVEN when the body carries an error code that would otherwise
  // fall through to the generic 'unknown' mapping. (Previously the in-body
  // branch short-circuited and returned 'unknown' before the 429 status check.)
  it('should map HTTP 429 with a generic in-body error code to rate_limited (429-precedence)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'Too Many Requests', code: 12345 } }),
        { status: 429 },
      ),
    );
    let caught: unknown;
    try {
      await connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).statusCode).toBe(429);
    expect((caught as ConnectorError).providerCode).toBe('rate_limited');
  });

  it('should map HTTP 429 with no in-body error code to rate_limited (429-precedence)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Too Many Requests' }), {
        status: 429,
      }),
    );
    await expect(
      connector.isochrone({
        center: { lat: 0, lng: 0 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({ providerCode: 'rate_limited' });
  });

  it('should convert minutes back to seconds on output contours', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          saPolygons: {
            features: [
              {
                attributes: { FromBreak: 0, ToBreak: 5 }, // 5 minutes
                geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await connector.isochrone({
      center: { lat: 0, lng: 0 },
      type: 'time',
      values: [300],
    });

    expect(result.contours[0]!.value).toBe(300); // 5 min × 60 = 300s
  });

  it('rejects a non-finite center with ConnectorError invalid_request (no fetch)', async () => {
    await expect(
      connector.isochrone({
        center: { lat: Number.NaN, lng: -74.006 },
        type: 'time',
        values: [600],
      }),
    ).rejects.toMatchObject({
      name: 'ConnectorError',
      providerCode: 'invalid_request',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
