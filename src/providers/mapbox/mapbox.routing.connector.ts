import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { encodePolyline, joinCoords, mergePassthrough } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { MapboxConfig } from './mapbox.config';

const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox';
const OPTIMIZED_TRIPS_URL = 'https://api.mapbox.com/optimized-trips/v2';

/**
 * Mapbox routing connector — the architectural outlier.
 *
 * Dispatches between two distinct Mapbox endpoints based on the optimization
 * flags on the {@link IRoutingOptions} input:
 *
 * `GET /directions/v5/mapbox/{profile}/{coords}` — plain routing.
 * `POST /optimized-trips/v2` — when any of
 *     `optimize | optimizeFixedOrigin | optimizeFixedDestination | isRoundTrip`
 *     is set.
 *
 * The dispatch logic lives entirely inside this connector — there
 * is no shared translator middleware. The connector-private precision-6
 * polyline decoder ({@link decodePrecision6}) re-encodes Mapbox's
 * `polyline6` geometry into the canonical precision-5 polyline returned by
 * every thinwrap location connector. locked the public
 * polyline surface at 4 functions; do not promote `decodePrecision6` to the
 * public utility.
 */
export class MapboxRoutingConnector
  extends BaseConnector
  implements IRoutingConnector
{
  readonly providerId = 'mapbox';

  constructor(private config: MapboxConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async route(options: IRoutingOptions): Promise<IRoutingResult> {
    if (options.waypoints.length < 2) {
      throw new ConnectorError({
        message: 'Mapbox Routing requires at least two waypoints',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'Mapbox Routing requires at least two waypoints',
      });
    }

    const useOptimized =
      options.optimize === true ||
      options.optimizeFixedOrigin === true ||
      options.optimizeFixedDestination === true ||
      options.isRoundTrip === true;

    const profile = this.mapProfile(options.travelMode);

    const response = useOptimized
      ? await this.dispatchOptimized(options, profile)
      : await this.dispatchDirections(options, profile);

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      throw this.mapVendorError(response.status, errBody);
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxRoutingResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'Mapbox returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Mapbox returned a malformed response body',
        cause: data,
      });
    }

    if (data.code && data.code !== 'Ok') {
      throw new ConnectorError({
        message: `Mapbox returned code: ${data.code}`,
        statusCode: response.status,
        providerCode: this.mapBodyCode(data.code),
        providerMessage: `Mapbox returned code: ${data.code}`,
        cause: data,
      });
    }

    // `/optimized-trips/v2` returns the routes under `trips`; `/directions/v5`
    // returns them under `routes`. Normalize.
    const routes =
      (data.routes && data.routes.length > 0
        ? data.routes
        : (data.trips ?? [])) || [];

    const route = routes[0];
    if (!route) {
      throw new ConnectorError({
        message: 'Mapbox returned no routes',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Mapbox returned no routes',
        cause: data,
      });
    }

    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distance ?? 0,
      durationSeconds: leg.duration ?? 0,
    }));

    // Re-encode precision-6 polyline geometry as precision-5. When
    // Mapbox returns an empty/missing geometry we emit an empty string rather
    // than throwing — the leg distance/duration fields are still meaningful.
    const polyline =
      typeof route.geometry === 'string' && route.geometry !== ''
        ? encodePolyline(decodePrecision6(route.geometry))
        : '';

    let waypointOrder: number[] | undefined;
    if (useOptimized && Array.isArray(data.waypoints)) {
      // Canonical `waypointOrder` = full visiting sequence of INPUT indices
      // (origin/destination inclusive). The Mapbox Optimization API returns
      // `waypoints[]` in INPUT order, where each `waypoint_index` is the
      // position that input waypoint occupies in the optimized trip — i.e. the
      // INVERSE of the canonical. Invert it: place each input index at its
      // visit position.
      const wps = data.waypoints;
      const order = new Array<number>(wps.length);
      let valid = true;
      for (let inputIdx = 0; inputIdx < wps.length; inputIdx++) {
        const pos = wps[inputIdx]?.waypoint_index;
        if (typeof pos !== 'number' || pos < 0 || pos >= wps.length) {
          valid = false;
          break;
        }
        order[pos] = inputIdx;
      }
      if (valid) {
        waypointOrder = order;
      }
    }

    return {
      legs,
      totalDistanceMeters: route.distance ?? 0,
      totalDurationSeconds: route.duration ?? 0,
      polyline,
      waypointOrder,
      raw: data,
    };
  }

  /**
   * Plain `/directions/v5` GET dispatch. Asks Mapbox for `polyline6`
   * geometry; we re-encode to precision-5 downstream.
   */
  private async dispatchDirections(
    options: IRoutingOptions,
    profile: string,
  ): Promise<Response> {
    const coords = joinCoords(options.waypoints, 'lnglat', ';');
    const url = `${DIRECTIONS_URL}/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
      geometries: 'polyline6',
      overview: 'full',
      steps: 'true',
      annotations: 'duration,distance',
    };

    const excludes = buildExcludes(options);
    if (excludes) baseQuery.exclude = excludes;

    if (options.departureTime) {
      baseQuery.depart_at = options.departureTime.toISOString();
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    return this.sendGet(url, { headers: merged.headers, query: merged.query });
  }

  /**
   * `/optimized-trips/v2` POST dispatch (3). Body carries `coordinates`,
   * `profile`, `roundtrip`, and the optional `source`/`destination` constraints.
   */
  private async dispatchOptimized(
    options: IRoutingOptions,
    profile: string,
  ): Promise<Response> {
    // Reject NaN/non-finite coordinates before they serialize into the request
    // body (JSON.stringify(NaN) === "null" would silently corrupt the geometry).
    // Mirrors the plain `/directions` path, where `joinCoords` guards the same.
    // Out-of-range but finite lat/lng pass through verbatim (thin-wrapper).
    for (const coord of options.waypoints) {
      assertFiniteCoordinate(coord, 'Mapbox routing waypoint');
    }
    const coordinates = options.waypoints.map((c) => [c.lng, c.lat]);

    const body: Record<string, unknown> = {
      coordinates,
      profile,
      roundtrip: options.isRoundTrip === true,
    };

    // fixed-origin/fixed-destination flags pin the endpoints; plain
    // `optimize: true` (without the fixed flags) leaves both unconstrained.
    if (options.optimizeFixedOrigin === true) {
      body.source = 'first';
    } else if (options.optimize === true) {
      body.source = 'any';
    }

    if (options.optimizeFixedDestination === true) {
      body.destination = 'last';
    } else if (options.optimize === true) {
      body.destination = 'any';
    }

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
    };

    const excludes = buildExcludes(options);
    if (excludes) baseQuery.exclude = excludes;

    if (options.departureTime) {
      baseQuery.depart_at = options.departureTime.toISOString();
    }

    const merged = mergePassthrough(body, {}, options._passthrough, baseQuery);

    return this.sendPostJson(OPTIMIZED_TRIPS_URL, merged.body, {
      headers: merged.headers,
      query: merged.query,
    });
  }

  /**
   * Map Mapbox HTTP status + body-shape to a canonical {@link ProviderCode}
   * The mapping is per-connector (no shared middleware).
   */
  private mapVendorError(
    status: number,
    body: Record<string, unknown> | null,
  ): ConnectorError {
    const code = typeof body?.code === 'string' ? body.code : '';
    const vendorMessage =
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : '';

    let providerCode: ProviderCode;
    if (status === 401 || status === 403) {
      providerCode = 'auth_failed';
    } else if (status === 429) {
      providerCode = 'rate_limited';
    } else if (status === 422) {
      if (code === 'NoRoute' || code === 'NoTrips') {
        providerCode = 'invalid_request';
      } else if (code === 'ProcessingError') {
        providerCode = 'unknown';
      } else {
        providerCode = 'unknown';
      }
    } else if (status >= 500 && status < 600) {
      providerCode = 'provider_unavailable';
    } else if (status === 400) {
      providerCode = 'invalid_request';
    } else {
      providerCode = 'unknown';
    }

    const message =
      vendorMessage !== ''
        ? vendorMessage
        : code !== ''
          ? `Mapbox returned code: ${code}`
          : `Mapbox routing failed: HTTP ${status}`;

    return new ConnectorError({
      message,
      statusCode: status,
      providerCode,
      providerMessage: message,
      cause: body ?? undefined,
    });
  }

  /**
   * Map a 200-OK envelope error code (`data.code !== 'Ok'`) to ProviderCode.
   * Mapbox occasionally returns HTTP 200 with a non-Ok envelope code such as
   * `NoRoute`, `NoSegment`, or `ProcessingError`.
   */
  private mapBodyCode(code: string): ProviderCode {
    switch (code) {
      case 'NoRoute':
      case 'NoTrips':
      case 'NoSegment':
      case 'InvalidInput':
        return 'invalid_request';
      case 'ProcessingError':
        return 'unknown';
      default:
        return 'unknown';
    }
  }

  private mapProfile(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'walking';
      case 'cycling':
        return 'cycling';
      default:
        return 'driving';
    }
  }
}

// --------------------------------------------------------------------------
// Module-private helpers
// --------------------------------------------------------------------------

interface MapboxRoutingLegRaw {
  distance?: number;
  duration?: number;
}

interface MapboxRoutingRouteRaw {
  geometry?: string;
  legs?: MapboxRoutingLegRaw[];
  distance?: number;
  duration?: number;
}

interface MapboxRoutingWaypointRaw {
  name?: string;
  waypoint_index?: number;
}

interface MapboxRoutingResponse {
  code?: string;
  routes?: MapboxRoutingRouteRaw[];
  trips?: MapboxRoutingRouteRaw[];
  waypoints?: MapboxRoutingWaypointRaw[];
}

function buildExcludes(options: IRoutingOptions): string {
  const excludes: string[] = [];
  if (options.avoidTolls) excludes.push('toll');
  if (options.avoidFerries) excludes.push('ferry');
  if (options.avoidHighways) excludes.push('motorway');
  return excludes.join(',');
}

/**
 * Connector-private precision-6 polyline decoder. A 1e6-divisor variant of
 * the standard precision-5 decoder. Deliberately not added to the public
 * polyline utility (locked the public surface at 4 functions).
 */
function decodePrecision6(encoded: string): LatLng[] {
  const coords: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  // Decode one signed varint group, bounds- and charset-guarded. Mirrors the
  // hardening of the shared `decodeSignedValue` (utils/polyline.ts): a
  // truncated/corrupt group or an out-of-charset byte throws a typed
  // ConnectorError('unknown') rather than silently producing garbage
  // coordinates.
  const decodeSigned = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (index >= encoded.length) {
        throw new ConnectorError({
          message: 'Malformed Mapbox polyline6 geometry',
          statusCode: null,
          providerCode: 'unknown',
          providerMessage: 'Malformed Mapbox polyline6 geometry',
        });
      }
      const charCode = encoded.charCodeAt(index++);
      b = charCode - 63;
      // Valid polyline characters are 63..126 (i.e. b in 0..63).
      if (b < 0 || b > 0x3f) {
        throw new ConnectorError({
          message: 'Malformed Mapbox polyline6 geometry',
          statusCode: null,
          providerCode: 'unknown',
          providerMessage: 'Malformed Mapbox polyline6 geometry',
        });
      }
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += decodeSigned();
    lng += decodeSigned();
    coords.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return coords;
}
