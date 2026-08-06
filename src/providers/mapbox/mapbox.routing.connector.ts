import { BaseConnector } from '../../base/base.connector';
import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  LatLng,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  assertRouteHasLegs,
  encodePolyline,
  invertWaypointPositions,
  joinCoords,
  mergePassthrough,
} from '../../utils';
import { toIsoSeconds } from '../../utils/datetime';
import type { MapboxConfig } from './mapbox.config';

const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox';
const OPTIMIZED_TRIPS_URL = 'https://api.mapbox.com/optimized-trips/v1/mapbox';

/**
 * Mapbox routing connector — the architectural outlier.
 *
 * Dispatches between two distinct Mapbox endpoints based on the optimization
 * flags on the {@link IRoutingOptions} input:
 *
 * `GET /directions/v5/mapbox/{profile}/{coords}` — plain routing.
 * `GET /optimized-trips/v1/mapbox/{profile}/{coords}` — waypoint-order
 *     optimization (single-vehicle TSP), when any of
 *     `optimize | optimizeFixedOrigin | optimizeFixedDestination | isRoundTrip`
 *     is set. (Optimization v1 is the single-route optimizer that matches every
 *     sibling provider's `optimize` behavior; v2 is a fleet/VRP product that
 *     belongs to a future multi-vehicle surface, not this facade.)
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

    const { response, geometries } = useOptimized
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

    // `/optimized-trips/v1` returns the routes under `trips`; `/directions/v5`
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
        // A 2xx with an empty routes/trips array is Mapbox saying "nothing
        // found", not a malformed response.
        providerCode: 'no_route',
        providerMessage: 'Mapbox returned no routes',
        cause: data,
      });
    }

    const legs = (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distance ?? 0,
      durationSeconds: leg.duration ?? 0,
    }));
    assertRouteHasLegs(legs.length, options.waypoints.length, 'Mapbox Routing', data);

    // Normalize the geometry to precision-5, decoding according to the
    // `geometries` value actually sent — NOT the connector's default, which
    // `_passthrough.query` may have overridden.
    const polyline = normalizeGeometry(route.geometry, geometries);

    let waypointOrder: number[] | undefined;
    if (useOptimized && Array.isArray(data.waypoints)) {
      // Canonical `waypointOrder` = full visiting sequence of INPUT indices
      // (origin/destination inclusive). The Mapbox Optimization API returns
      // `waypoints[]` in INPUT order, where each `waypoint_index` is the
      // position that input waypoint occupies in the optimized trip — i.e. the
      // INVERSE of the canonical. Invert it: place each input index at its
      // visit position. Validated against the INPUT waypoint count, so a
      // truncated or duplicate-index `waypoints[]` omits the ordering instead
      // of yielding a permutation that silently drops or repeats a waypoint.
      waypointOrder = invertWaypointPositions(
        data.waypoints.map((wp) => wp?.waypoint_index),
        options.waypoints.length,
      );
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
   * geometry; we re-encode to precision-5 downstream. Returns the effective
   * `geometries` alongside the response so the caller decodes what was actually
   * requested.
   */
  private async dispatchDirections(
    options: IRoutingOptions,
    profile: string,
  ): Promise<MapboxDispatch> {
    const coords = joinCoords(options.waypoints, 'lnglat', ';');
    const url = `${DIRECTIONS_URL}/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
      geometries: 'polyline6',
      overview: mapboxOverview(options),
    };

    const excludes = buildExcludes(options);
    if (excludes) baseQuery.exclude = excludes;

    if (options.departureTime) {
      // Mapbox documents `depart_at` as one of exactly three ISO 8601 forms,
      // none carrying milliseconds — so seconds precision, not toISOString().
      baseQuery.depart_at = toIsoSeconds(options.departureTime);
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: merged.query,
    });
    return { response, geometries: readEffectiveGeometries(merged.query) };
  }

  /**
   * `/optimized-trips/v1` GET dispatch. `joinCoords` guards finite coordinates
   * and builds the `lng,lat;…` path. The `source`/`destination`/`roundtrip`
   * query params select the optimization shape.
   *
   * Optimization v1 (OSRM-trip-based) requires that a non-roundtrip request fix
   * at least one endpoint — `source=any` + `destination=any` + `roundtrip=false`
   * is rejected. So plain `optimize` (and the both-fixed case) keeps BOTH
   * endpoints and reorders the intermediates, matching Google/TomTom/HERE/Esri;
   * the fixed-origin/-destination flags pin just their endpoint and free the
   * other; `isRoundTrip` returns to the first waypoint.
   */
  private async dispatchOptimized(
    options: IRoutingOptions,
    profile: string,
  ): Promise<MapboxDispatch> {
    const coords = joinCoords(options.waypoints, 'lnglat', ';');
    const url = `${OPTIMIZED_TRIPS_URL}/${profile}/${coords}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
      geometries: 'polyline6',
      overview: mapboxOverview(options),
      roundtrip: options.isRoundTrip === true ? 'true' : 'false',
    };

    if (options.isRoundTrip === true) {
      // Round trip returns to the first waypoint.
      baseQuery.source = 'first';
    } else if (
      options.optimizeFixedOrigin === true &&
      options.optimizeFixedDestination !== true
    ) {
      baseQuery.source = 'first';
      baseQuery.destination = 'any';
    } else if (
      options.optimizeFixedDestination === true &&
      options.optimizeFixedOrigin !== true
    ) {
      baseQuery.source = 'any';
      baseQuery.destination = 'last';
    } else {
      // Plain `optimize`, or both endpoints fixed: keep origin first and
      // destination last, reorder the middle (the only any/any alternative that
      // v1 accepts for a non-roundtrip request).
      baseQuery.source = 'first';
      baseQuery.destination = 'last';
    }

    const excludes = buildExcludes(options);
    if (excludes) baseQuery.exclude = excludes;

    if (options.departureTime) {
      // Mapbox documents `depart_at` as one of exactly three ISO 8601 forms,
      // none carrying milliseconds — so seconds precision, not toISOString().
      baseQuery.depart_at = toIsoSeconds(options.departureTime);
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: merged.query,
    });
    return { response, geometries: readEffectiveGeometries(merged.query) };
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
      // Live-verified: Mapbox serves its no-route envelope with HTTP 422, so the
      // envelope code — not the status — decides whether this is "no route" or a
      // malformed request.
      if (code === 'NoRoute' || code === 'NoTrips' || code === 'NoSegment') {
        providerCode = 'no_route';
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
      // The request was well-formed and Mapbox answered — there is simply no
      // connecting route (or no road near a coordinate to snap to). A business
      // outcome to branch on, not a client bug.
      case 'NoRoute':
      case 'NoTrips':
      case 'NoSegment':
        return 'no_route';
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
  /**
   * An encoded polyline (`geometries=polyline6` / `polyline`) or a GeoJSON
   * LineString object (`geometries=geojson`). The shape follows the effective
   * `geometries` request parameter, which `_passthrough.query` can override.
   */
  geometry?: string | { coordinates?: unknown };
  legs?: MapboxRoutingLegRaw[];
  distance?: number;
  duration?: number;
}

/**
 * A dispatch result: the HTTP response plus the `geometries` value actually
 * sent, which the geometry normalizer must match.
 */
interface MapboxDispatch {
  response: Response;
  geometries: string;
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

/**
 * Map the normalized `polylineQuality` onto Mapbox's `overview`.
 *
 * `simplified` is the default and the reason is measured, not aesthetic: on one
 * ~140km route the simplified geometry was 203 characters against 6146 for
 * `full` — a 30x payload for vertices most callers never look at, with identical
 * distances and durations.
 *
 * `steps` and `annotations` are deliberately NOT sent. Nothing in
 * `IRoutingResult` reads turn-by-turn steps or per-segment annotations, and
 * steps are the single largest part of a Mapbox routing response — so requesting
 * them inflated every response for data the wrapper then discarded. A consumer
 * who wants them adds `_passthrough.query`.
 */
function mapboxOverview(options: IRoutingOptions): string {
  return options.polylineQuality === 'detailed' ? 'full' : 'simplified';
}

function buildExcludes(options: IRoutingOptions): string {
  const excludes: string[] = [];
  if (options.avoidTolls) excludes.push('toll');
  if (options.avoidFerries) excludes.push('ferry');
  if (options.avoidHighways) excludes.push('motorway');
  return excludes.join(',');
}

/**
 * The effective `geometries` value actually sent, after `_passthrough.query`
 * has been merged over the connector's own `polyline6`.
 *
 * The geometry decoder MUST match what was requested. Decoding a precision-5
 * `polyline` with the precision-6 decoder divides every coordinate by 10 — a
 * silent 10x position shift, not an error — so the connector reads back its own
 * effective query rather than assuming its default survived the override.
 */
function readEffectiveGeometries(query: Record<string, string>): string {
  const value = query.geometries;
  return typeof value === 'string' && value !== '' ? value : 'polyline6';
}

/**
 * Normalize a Mapbox route geometry to the canonical Google-precision-5
 * polyline, honoring the effective `geometries` parameter:
 *
 * - `polyline6` (connector default) — decode at precision 6, re-encode at 5.
 * - `polyline` — already precision-5; emit verbatim (as the OSRM connector does).
 * - `geojson` — encode the `[lng, lat]` coordinate pairs at precision 5.
 *
 * Returns an empty string for an absent, empty, or unparseable geometry rather
 * than throwing — the leg distance/duration fields are still meaningful.
 */
function normalizeGeometry(
  geometry: string | { coordinates?: unknown } | undefined,
  geometries: string,
): string {
  if (geometries === 'geojson') {
    const coordinates =
      typeof geometry === 'object' && geometry !== null
        ? geometry.coordinates
        : undefined;
    if (!Array.isArray(coordinates)) return '';
    const points: LatLng[] = [];
    for (const pair of coordinates) {
      if (!Array.isArray(pair)) return '';
      const [lng, lat] = pair as unknown[];
      if (typeof lat !== 'number' || typeof lng !== 'number') return '';
      points.push({ lat, lng });
    }
    return encodePolyline(points);
  }

  if (typeof geometry !== 'string' || geometry === '') return '';
  if (geometries === 'polyline') return geometry;
  return encodePolyline(decodePrecision6(geometry));
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
