import type { Polygon } from 'geojson';
import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { decodeFlexPolyline, mergePassthrough, validateIsochroneCap } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { HereConfig } from './here.config';
import type { HereIsolineResponse } from './here.types';

const ISOLINE_URL = 'https://isoline.router.hereapi.com/v8/isolines';

/**
 * HERE Isolines v8 connector.
 *
 * GETs `https://isoline.router.hereapi.com/v8/isolines` with `origin`,
 * `range[type]`, `range[values]`, `transportMode`, and the `apiKey` query
 * parameter.
 *
 * **Travel mode mapping.** Per base, only `'driving'` and
 * `'walking'` are baseline — HERE does NOT augment `IsochroneOptionsMap`. The
 * connector maps `'driving' → 'car'` and `'walking' → 'pedestrian'`.
 *
 * **Range params.** Native units (seconds for time, meters for
 * distance) — no conversion.
 *
 * **Response normalization.** HERE returns each isoline's outer ring
 * as a flexible-polyline string; {@link decodeFlexPolyline} decodes it, and
 * the connector closes the GeoJSON Polygon ring by appending the first
 * coordinate when the boundary is not already closed.
 *
 * **Cap.** {@link validateIsochroneCap} enforces a 4-value
 * ceiling at the top of `.isochrone`.
 *
 * v1.0 ignores `polygons[j].inner[]` holes; documented in the per-connector
 * README.
 */
export class HereIsochroneConnector
  extends BaseConnector
  implements IIsochroneConnector
{
  readonly providerId = 'here';

  constructor(private config: HereConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async isochrone(options: IIsochroneOptions): Promise<IIsochroneResult> {
    validateIsochroneCap(options);

    assertFiniteCoordinate(options.center, 'HERE isochrone center');

    const transportMode = this.mapTransportMode(options.travelMode);

    const baseQuery: Record<string, string> = {
      apiKey: this.config.apiKey,
      origin: `${options.center.lat},${options.center.lng}`,
      'range[type]': options.type,
      'range[values]': options.values.join(','),
      transportMode,
    };

    if (options.departureTime !== undefined && options.departureTime !== '') {
      baseQuery.departureTime = options.departureTime;
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(ISOLINE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    const data = (await response.json().catch(() => null)) as
      | HereIsolineResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Isochrone returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Isochrone returned a malformed response body',
        cause: data,
      });
    }

    const contours = (data.isolines ?? [])
      .map((iso) => {
        const outerFlex = iso.polygons?.[0]?.outer;
        const coords = outerFlex ? decodeFlexPolyline(outerFlex) : [];
        const ring = coords.map((c) => [c.lng, c.lat]);
        // Close the ring if not already closed (GeoJSON requires it).
        if (ring.length > 0) {
          const first = ring[0]!;
          const last = ring[ring.length - 1]!;
          if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([first[0]!, first[1]!]);
          }
        }
        const polygon: Polygon = {
          type: 'Polygon',
          coordinates: [ring],
        };
        return {
          value: iso.range.value,
          geometry: polygon,
        };
      })
      .sort((a, b) => a.value - b.value);

    return { contours, raw: data };
  }

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
      message: `HERE Isochrone failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map HERE (HTTP status) → canonical {@link ProviderCode}. Mirrors
   * */
  private mapVendorError(httpStatus: number): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readHereErrorMessage(body);

    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null ? `${base}; ${suffix}` : suffix;
      }
    }

    return base;
  }

  private mapTransportMode(mode?: 'driving' | 'walking'): string {
    switch (mode) {
      case 'walking':
        return 'pedestrian';
      default:
        return 'car';
    }
  }
}

function readHereErrorMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  const title = body.title;
  const cause = body.cause;
  if (typeof title === 'string' && title !== '') {
    if (typeof cause === 'string' && cause !== '') {
      return `${title}: ${cause}`;
    }
    return title;
  }
  if (typeof cause === 'string' && cause !== '') return cause;
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  const error = body.error;
  if (typeof error === 'string' && error !== '') return error;
  return null;
}
