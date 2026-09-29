import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  decodeFlexPolyline,
  isFiniteNumber,
  isRecord,
  malformedResponseError,
  mergePassthrough,
  optionalArray,
  toContourGeometry,
  validateIsochroneCap,
} from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { HereConfig } from './here.config';
import type { HereIsolineResponse } from './here.types';

type HereIsoline = HereIsolineResponse['isolines'][number];

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
 * **Response normalization.** HERE types `isolines[].polygons` as a
 * MultiPolygon — one `{ outer, inner[] }` entry per disconnected part (parts
 * joined only by a ferry are listed under `connections`), each ring a
 * flexible-polyline string. {@link decodeFlexPolyline} decodes every outer and
 * inner ring, and {@link toContourGeometry} closes and winds them: one part is
 * a `Polygon`, several a `MultiPolygon` holding all of them, holes kept.
 *
 * **Cap.** {@link validateIsochroneCap} enforces a 4-value
 * ceiling at the top of `.isochrone`.
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

    const transportMode = this.mapTransportMode(
      options.travelMode as 'driving' | 'walking' | 'cycling' | undefined,
    );

    const baseQuery: Record<string, string> = {
      apiKey: this.config.apiKey,
      origin: `${formatCoord(options.center.lat)},${formatCoord(options.center.lng)}`,
      'range[type]': options.type,
      // Plain decimals: `String(1e21)` is `1e+21`, which HERE does not parse.
      'range[values]': options.values.map(formatCoord).join(','),
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
    if (!isRecord(data)) {
      throw new ConnectorError({
        message: 'HERE Isochrone returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Isochrone returned a malformed response body',
        cause: data,
      });
    }

    const isolines = optionalArray(data.isolines);
    if (isolines === null || isolines.length === 0) {
      throw malformedResponseError('HERE Isochrone', 'no isolines', response.status, data);
    }

    const contours = isolines
      .map((entry) => {
        const iso = isRecord(entry) ? (entry as unknown as HereIsoline) : null;
        const value: unknown = iso?.range?.value;
        const parts = optionalArray(iso?.polygons);
        // An isoline with no outer ring describes no area: refuse it rather than
        // emit an empty `[[]]` polygon.
        if (!isFiniteNumber(value) || parts === null || parts.length === 0) {
          throw malformedResponseError(
            'HERE Isochrone',
            'an isoline has no range value or no outer polygon',
            response.status,
            data,
          );
        }
        // An unusable part is dropped rather than failing the isochrone; an
        // isoline left with no usable part at all describes no area.
        const polygons = parts
          .map(decodeHerePolygon)
          .filter((polygon): polygon is number[][][] => polygon !== null);
        if (polygons.length === 0) {
          throw malformedResponseError(
            'HERE Isochrone',
            'an isoline has no usable outer ring',
            response.status,
            data,
          );
        }
        return { value, geometry: toContourGeometry(polygons) };
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
   * Map HERE (HTTP status) → canonical {@link ProviderCode}, the same table as
   * the other HERE connectors.
   */
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

  /**
   * HERE's normalized isochrone modes are driving and walking (`'cycling'` is
   * not in its input type). A `'cycling'` that arrives anyway, from JS or a
   * variable typed for Mapbox/TomTom, fails fast with the capability code Esri
   * uses, rather than silently computing a car isoline. HERE lists its own
   * `bicycle` isoline mode as Beta with limited functionality; a caller who
   * wants it sends `_passthrough.query.transportMode = 'bicycle'`.
   */
  private mapTransportMode(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'pedestrian';
      case 'cycling': {
        const message = 'HERE Isoline Routing does not support travelMode "cycling"';
        throw new ConnectorError({
          message,
          statusCode: null,
          providerCode: 'unsupported_travel_mode',
          providerMessage: message,
        });
      }
      default:
        return 'car';
    }
  }
}

/**
 * One HERE isoline polygon `{ outer, inner? }` as `[exterior, ...holes]` in
 * `[lng, lat]` order, or `null` when the outer ring is missing, empty or
 * undecodable — a part without an exterior describes no area. An unreadable
 * inner ring is dropped instead: losing a hole overstates the area slightly,
 * while dropping the part would lose all of it.
 */
function decodeHerePolygon(part: unknown): number[][][] | null {
  if (!isRecord(part)) return null;
  const outer = decodeRing(part.outer);
  if (outer === null) return null;
  const holes = (optionalArray(part.inner) ?? [])
    .map(decodeRing)
    .filter((ring): ring is number[][] => ring !== null);
  return [outer, ...holes];
}

/** A flexible-polyline ring as `[lng, lat]` positions, or `null` when unusable. */
function decodeRing(flex: unknown): number[][] | null {
  if (typeof flex !== 'string' || flex === '') return null;
  try {
    const ring = decodeFlexPolyline(flex).map((c) => [c.lng, c.lat]);
    return ring.length > 0 ? ring : null;
  } catch {
    // `decodeFlexPolyline` throws on a truncated or invalid string.
    return null;
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
