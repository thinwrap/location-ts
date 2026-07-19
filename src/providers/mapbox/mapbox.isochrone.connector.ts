import type { Polygon } from 'geojson';
import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { mergePassthrough, validateIsochroneCap } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { MapboxConfig } from './mapbox.config';
import type { MapboxIsochroneResponse } from './mapbox.types';

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
 * overwritten. Without it Mapbox returns LineString rings which don't fit
 * {@link Polygon}.
 *
 * **Travel mode mapping** with cycling per the `IsochroneOptionsMap`
 * augmentation (`mapbox.types.ts`):
 *   - `'driving'`  → `mapbox/driving`.
 *   - `'walking'`  → `mapbox/walking`.
 *   - `'cycling'`  → `mapbox/cycling` (Mapbox native).
 *
 * **Values translation.** `type: 'time'` → input seconds divided by 60
 * (round to nearest) into `contours_minutes`. `type: 'distance'` → input
 * meters passed through into `contours_meters`.
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
    const url = `${ISOCHRONE_URL}/${profile}/${options.center.lng},${options.center.lat}`;

    const baseQuery: Record<string, string> = {
      access_token: this.config.accessToken,
    };

    if (options.type === 'time') {
      baseQuery.contours_minutes = options.values
        .map((v) => Math.round(v / 60))
        .join(',');
    } else {
      baseQuery.contours_meters = options.values.join(',');
    }

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

    if (data === null) {
      throw new ConnectorError({
        message: 'Mapbox returned a non-JSON/unparseable body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Mapbox returned a non-JSON/unparseable body',
        cause: data,
      });
    }

    // Mapbox returns `contour` in minutes when `contours_minutes` was used
    // (mirrors the metric the caller requested). Bring back to seconds so the
    // contour `value` matches the input unit.
    const contours = (data.features ?? [])
      .map((f) => {
        const contour = f.properties.contour;
        const value =
          options.type === 'time' ? contour * 60 : contour;
        const polygon: Polygon = {
          type: 'Polygon',
          coordinates: f.geometry.coordinates,
        };
        return { value, geometry: polygon };
      })
      .sort((a, b) => a.value - b.value);

    return { contours, raw: data };
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx. Per
   * memory design: parsed Retry-After seconds
   * are woven into `providerMessage` and the raw header is carried in
   * `cause.retryAfter`.
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
   * Map Mapbox (HTTP status) → canonical {@link ProviderCode}. Mirrors
   * / 1.14: 401/403 → auth_failed, 429 → rate_limited, 422/400 →
   * invalid_request, 5xx → provider_unavailable.
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

function readMapboxMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof body.error === 'string' && body.error !== '') return body.error;
  return null;
}
