import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  isFiniteNumber,
  isRecord,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
  toContourGeometry,
  usablePolygon,
  validateIsochroneCap,
} from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { MapboxConfig } from './mapbox.config';
import type { MapboxIsochroneResponse } from './mapbox.types';

type MapboxIsochroneFeature = MapboxIsochroneResponse['features'][number];

const ISOCHRONE_URL = 'https://api.mapbox.com/isochrone/v1/mapbox';

/**
 * Mapbox Isochrone v1 connector.
 *
 * GETs `https://api.mapbox.com/isochrone/v1/mapbox/{profile}/<lng>,<lat>` with
 * `contours_minutes`/`contours_meters`, `polygons=true`, and the `access_token`
 * query parameter.
 *
 * **`polygons=true` invariant.** Set AFTER the `_passthrough` merge so a
 * consumer attempt to override it via `_passthrough.query.polygons` is silently
 * overwritten. Without it Mapbox returns LineString rings, which describe no
 * area.
 *
 * **Response normalization.** Each feature's geometry is read as a `Polygon`,
 * or as a `MultiPolygon` when its `type` says so, and goes through
 * {@link toContourGeometry} like every isochrone provider: rings closed and wound
 * per RFC 7946, holes kept, a single part reported as a `Polygon`.
 *
 * **Travel mode mapping** with cycling per the `IsochroneOptionsMap`
 * augmentation (`mapbox.types.ts`):
 *   - `'driving'`  → `mapbox/driving`.
 *   - `'walking'`  → `mapbox/walking`.
 *   - `'cycling'`  → `mapbox/cycling` (Mapbox native).
 *
 * **Values translation.** Mapbox takes integer contours (1–60 minutes,
 * 1–100000 meters) in increasing order, so the caller's values are sorted
 * ascending and rounded: `type: 'time'` seconds to whole minutes for
 * `contours_minutes`, `type: 'distance'` meters to whole meters for
 * `contours_meters`. A time under 60 s (below Mapbox's 1-minute floor) or two
 * values that round to the same contour are refused as `invalid_request`
 * before any request. Each returned contour's `value` is the caller's own
 * value for that contour, not the rounded one scaled back.
 *
 * **Cap.** {@link validateIsochroneCap} enforces the 4-value
 * ceiling at the top of `.isochrone()`.
 */
export class MapboxIsochroneConnector
  extends BaseConnector
  implements IIsochroneConnector
{
  readonly providerId = 'mapbox';

  constructor(private config: MapboxConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async isochrone(options: IIsochroneOptions): Promise<IIsochroneResult> {
    validateIsochroneCap(options);
    assertFiniteCoordinate(options.center, 'Mapbox isochrone center');

    const profile = this.mapProfile(
      options.travelMode as 'driving' | 'walking' | 'cycling' | undefined,
    );
    const url = `${ISOCHRONE_URL}/${profile}/${formatCoord(options.center.lng)},${formatCoord(options.center.lat)}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
    };

    const contourToValue = buildContours(options);
    const contourKey = options.type === 'time' ? 'contours_minutes' : 'contours_meters';
    baseQuery[contourKey] = [...contourToValue.keys()].join(',');

    if (options.departureTime !== undefined && options.departureTime !== '') {
      baseQuery.depart_at = options.departureTime;
    }

    // Merge passthrough first, then re-stamp `polygons=true` so a consumer
    // attempt to override it via `_passthrough.query.polygons` is silently
    // overwritten (invariant — without it Mapbox returns LineString).
    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const finalQuery: Record<string, string> = {
      ...merged.query,
      polygons: 'true',
    };

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: finalQuery,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxIsochroneResponse
      | null;

    if (!isRecord(data)) {
      throw new ConnectorError({
        message: 'Mapbox returned a non-JSON/unparseable body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Mapbox returned a non-JSON/unparseable body',
        cause: data,
      });
    }

    // Mapbox documents HTTP 200 for "No route found" / "Could not find a
    // matching segment", so an envelope code other than `Ok` is read here.
    if (typeof data.code === 'string' && data.code !== 'Ok') {
      const message =
        typeof data.message === 'string' && data.message !== ''
          ? data.message
          : `Mapbox returned code: ${data.code}`;
      throw new ConnectorError({
        message,
        statusCode: response.status,
        providerCode: data.code === 'NoRoute' || data.code === 'NoSegment' ? 'no_route' : 'unknown',
        providerMessage: message,
        cause: data,
      });
    }

    const features = optionalArray(data.features);
    if (features === null || features.length === 0) {
      throw malformedResponseError('Mapbox Isochrone', 'no contour features', response.status, data);
    }

    const contours = features
      .map((f) => {
        const feature = isRecord(f) ? (f as unknown as MapboxIsochroneFeature) : null;
        const contour: unknown = feature?.properties?.contour;
        const polygons = readMapboxPolygons(feature?.geometry);
        if (!isFiniteNumber(contour) || polygons === null) {
          throw malformedResponseError(
            'Mapbox Isochrone',
            'a contour has no numeric value or no polygon',
            response.status,
            data,
          );
        }
        // `contour` echoes the integer minutes/meters that were sent. The
        // caller's own value for it is reported, so 90 s stays 90 s instead of
        // becoming 2 min × 60. A contour the connector did not send (a
        // passthrough override) is converted as-is.
        const value =
          contourToValue.get(contour) ?? (options.type === 'time' ? contour * 60 : contour);
        return { value, geometry: toContourGeometry(polygons) };
      })
      .sort((a, b) => a.value - b.value);

    return { contours, raw: data };
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx.
   * Parsed Retry-After seconds are woven into `providerMessage` and the raw
   * header is carried in `cause.retryAfter`.
   */
  private async raiseHttpError(response: Response): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null
        ? { ...(errorBody ?? {}), retryAfter }
        : errorBody;
    return new ConnectorError({
      message: `Mapbox Isochrone failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map Mapbox (HTTP status) → canonical {@link ProviderCode}: 401/403 →
   * auth_failed, 429 → rate_limited, 422/400 → invalid_request, 5xx →
   * provider_unavailable.
   */
  private mapVendorError(httpStatus: number): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 422) return 'invalid_request';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readMapboxMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
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

/**
 * The integer contours to send, in the increasing order Mapbox requires, each
 * mapped to the caller's original value.
 */
function buildContours(options: IIsochroneOptions): Map<number, number> {
  const isTime = options.type === 'time';
  const contourToValue = new Map<number, number>();
  for (const value of [...options.values].sort((a, b) => a - b)) {
    const contour = isTime ? Math.round(value / 60) : Math.round(value);
    // Mapbox's floor is 1 minute; a sub-minute break rounded up to it would
    // silently describe a larger area than asked for.
    if (isTime ? value < 60 : contour < 1) {
      throw invalidBreak(
        isTime
          ? `Mapbox Isochrone contours are whole minutes; ${value} s is under the 1-minute minimum`
          : `Mapbox Isochrone contours are whole meters; ${value} m rounds below the 1-meter minimum`,
      );
    }
    const previous = contourToValue.get(contour);
    if (previous !== undefined) {
      throw invalidBreak(
        `Mapbox Isochrone contours are whole ${isTime ? 'minutes' : 'meters'}; ` +
          `${previous} and ${value} both round to ${contour}`,
      );
    }
    contourToValue.set(contour, value);
  }
  return contourToValue;
}

/**
 * A feature geometry's usable polygons, or `null` when it holds none. A geometry
 * without `type: 'MultiPolygon'` is read as a Polygon, as it always has been (a
 * LineString's coordinates are one level too shallow and read as unusable). An
 * unusable part or hole is dropped rather than failing the whole response.
 */
function readMapboxPolygons(geometry: unknown): number[][][][] | null {
  if (!isRecord(geometry)) return null;
  const coordinates: unknown = geometry.coordinates;
  const parts = geometry.type === 'MultiPolygon' && Array.isArray(coordinates) ? coordinates : [coordinates];
  const polygons = parts
    .map(usablePolygon)
    .filter((polygon): polygon is number[][][] => polygon !== null);
  return polygons.length > 0 ? polygons : null;
}

function invalidBreak(message: string): ConnectorError {
  return new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}

function readMapboxMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof body.error === 'string' && body.error !== '') return body.error;
  return null;
}
