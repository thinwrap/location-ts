import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorError } from '../types';
import { EsriRoutingConnector } from './esri/esri.routing.connector';
import { GoogleRoutingConnector } from './google/google.routing.connector';
import { HereRoutingConnector } from './here/here.routing.connector';
import { MapboxRoutingConnector } from './mapbox/mapbox.routing.connector';
import { OsrmRoutingConnector } from './osrm/osrm.routing.connector';
import { TomTomRoutingConnector } from './tomtom/tomtom.routing.connector';

/**
 * Cross-provider `no_route` contract.
 *
 * Every fixture in this file is the LIVE-OBSERVED body for an unroutable
 * request, captured from the real API — change one only against a fresh live
 * capture, never against the vendor's docs, which were wrong for three of the
 * six. The point of the normalized code is that the vendors agree on nothing:
 *
 * | Provider | HTTP | Where the signal lives                          |
 * |----------|------|-------------------------------------------------|
 * | Google   | 200  | `routes` key absent entirely                      |
 * | HERE     | 200  | `routes: []` + `notices[].code`                   |
 * | Mapbox   | 200  | `code: "NoRoute"` (also seen as 422)              |
 * | OSRM     | 400  | `code: "NoRoute"` / `"NoSegment"`                 |
 * | TomTom   | 400  | `detailedError.code: "MAP_MATCHING_FAILURE"`      |
 * | Esri     | 200  | `error.code: 400` + `details[]` saying "unlocated"|
 *
 * A consumer branching on "no usable route" previously had to reimplement all
 * six of those. One code replaces them.
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
  { lat: 40, lng: -30 },
  { lat: 62.0758, lng: 6.0782 },
];

function resp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function codeOf(run: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    return err as ConnectorError;
  }
  throw new Error('expected a ConnectorError');
}

describe('no_route — cross-provider, from live-captured vendor bodies', () => {
  it('Google: HTTP 200 with the routes key absent', async () => {
    // Verbatim live body.
    mockFetch.mockResolvedValueOnce(resp({}));
    const ce = await codeOf(() =>
      new GoogleRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
    expect(ce.statusCode).toBe(200);
  });

  it('Google: HTTP 200 with an empty routes array', async () => {
    mockFetch.mockResolvedValueOnce(resp({ routes: [] }));
    const ce = await codeOf(() =>
      new GoogleRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
  });

  it('HERE: HTTP 200 with routes: [] and a critical notice', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        notices: [
          {
            title: "Route calculation failed: Couldn't match origin.",
            code: 'couldNotMatchOrigin',
            severity: 'critical',
          },
        ],
        routes: [],
      }),
    );
    const ce = await codeOf(() =>
      new HereRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
    // The notice explains WHY, so it is surfaced rather than buried in `cause`.
    expect(ce.providerMessage).toContain('couldNotMatchOrigin');
    expect(ce.providerMessage).toContain("Couldn't match origin");
  });

  it('HERE: falls back to a plain message when no notice is present', async () => {
    mockFetch.mockResolvedValueOnce(resp({ routes: [] }));
    const ce = await codeOf(() =>
      new HereRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
    expect(ce.providerMessage).toBe('HERE Routing returned no routes');
  });

  it('Mapbox: HTTP 200 with code NoRoute', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ code: 'NoRoute', message: 'No route found', routes: [] }),
    );
    const ce = await codeOf(() =>
      new MapboxRoutingConnector({ accessToken: 'pk' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
  });

  it('Mapbox: HTTP 422 with code NoRoute', async () => {
    mockFetch.mockResolvedValueOnce(resp({ code: 'NoRoute' }, 422));
    const ce = await codeOf(() =>
      new MapboxRoutingConnector({ accessToken: 'pk' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
    expect(ce.statusCode).toBe(422);
  });

  it.each([
    ['NoRoute', 400],
    ['NoSegment', 400],
  ])('OSRM: HTTP %i with code %s', async (code, status) => {
    mockFetch.mockResolvedValueOnce(resp({ code, message: 'no route' }, status));
    const ce = await codeOf(() =>
      new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
        waypoints: TWO,
      }),
    );
    expect(ce.providerCode).toBe('no_route');
    // The real status is preserved, unlike the previous `statusCode: null`.
    expect(ce.statusCode).toBe(status);
  });

  // The envelope says the request was fine and the server answered, so there is
  // nothing to return.
  it.each([
    ['routes', { code: 'Ok', routes: [] }],
    ['routes and trips', { code: 'Ok', routes: [], trips: [] }],
  ])('OSRM: HTTP 200, envelope code Ok, empty %s', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(resp(body));
    const ce = await codeOf(() =>
      new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
        waypoints: TWO,
      }),
    );
    expect(ce.providerCode).toBe('no_route');
    // The real status: this path is only reachable on a 2xx.
    expect(ce.statusCode).toBe(200);
    expect(ce.providerMessage).toContain('no routes');
  });

  it('TomTom: HTTP 400 with detailedError.code MAP_MATCHING_FAILURE', async () => {
    mockFetch.mockResolvedValueOnce(
      resp(
        {
          formatVersion: '0.0.12',
          detailedError: {
            message:
              'Engine error while executing route request: MAP_MATCHING_FAILURE: Origin (40, -30)',
            code: 'MAP_MATCHING_FAILURE',
          },
        },
        400,
      ),
    );
    const ce = await codeOf(() =>
      new TomTomRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
    expect(ce.statusCode).toBe(400);
  });

  it('TomTom: HTTP 400 with NO_ROUTE_FOUND', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ detailedError: { code: 'NO_ROUTE_FOUND' } }, 400),
    );
    const ce = await codeOf(() =>
      new TomTomRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
  });

  it('Esri: HTTP 200 with an in-body error naming an unlocated stop', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        error: {
          code: 400,
          message: 'Unable to complete operation.',
          details: [
            'Location "Location 1" in "Stops" is unlocated.  Need at least 2 valid stops.  "Stops" does not contain valid input for any route.',
          ],
        },
      }),
    );
    const ce = await codeOf(() =>
      new EsriRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('no_route');
  });

  // The guard against over-reaching: a genuine 400 must NOT become `no_route`
  // just because it shares Esri's in-body error code.
  it('Esri: an in-body 400 without an unlocated stop stays invalid_request', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        error: {
          code: 400,
          message: 'Unable to complete operation.',
          details: ['Invalid value for parameter travelMode.'],
        },
      }),
    );
    const ce = await codeOf(() =>
      new EsriRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('invalid_request');
  });

  it('Esri: an in-body 400 with no details array stays invalid_request', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ error: { code: 400, message: 'Unable to complete operation.' } }),
    );
    const ce = await codeOf(() =>
      new EsriRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('invalid_request');
  });
});

describe('no_route does not swallow genuine request errors', () => {
  it.each([
    ['InvalidOptions', 'invalid_request'],
    ['InvalidValue', 'invalid_request'],
    ['InvalidQuery', 'invalid_request'],
  ])('OSRM %s stays %s', async (code, expected) => {
    mockFetch.mockResolvedValueOnce(resp({ code }, 400));
    const ce = await codeOf(() =>
      new OsrmRoutingConnector({ baseUrl: 'http://localhost:5000' }).route({
        waypoints: TWO,
      }),
    );
    expect(ce.providerCode).toBe(expected);
  });

  it('TomTom keeps a plain 400 as invalid_request when no code is present', async () => {
    mockFetch.mockResolvedValueOnce(resp({ error: { description: 'bad' } }, 400));
    const ce = await codeOf(() =>
      new TomTomRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('invalid_request');
  });

  it('TomTom keeps auth failures as auth_failed even with a no-route code', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ detailedError: { code: 'MAP_MATCHING_FAILURE' } }, 403),
    );
    const ce = await codeOf(() =>
      new TomTomRoutingConnector({ apiKey: 'k' }).route({ waypoints: TWO }),
    );
    expect(ce.providerCode).toBe('auth_failed');
  });
});
