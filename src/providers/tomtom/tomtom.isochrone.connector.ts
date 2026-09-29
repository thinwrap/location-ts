import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneContour,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import {
  isFiniteNumber,
  isRecord,
  mergePassthrough,
  toContourGeometry,
  validateIsochroneCap,
} from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { TomTomConfig } from './tomtom.config';
import type { TomTomReachableRangeResponse } from './tomtom.types';

const REACHABLE_RANGE_URL = 'https://api.tomtom.com/routing/1/calculateReachableRange';

/**
 * TomTom Reachable Range connector — the one isochrone connector that issues
 * several HTTP calls per request.
 *
 * TomTom's `calculateReachableRange` API takes only ONE budget value per call;
 * multi-band isochrones therefore require N parallel HTTP calls, and the N-call
 * assembly lives inside this connector. This is the only connector
 * that populates `result._meta` — and only when N>1 (multi-band). A single-band
 * request is a single HTTP call and omits `_meta` entirely.
 *
 * **Wire shape.** `GET https://api.tomtom.com/routing/1/calculateReachableRange/{lat},{lng}/json`
 * with `timeBudgetInSec` (for `type: 'time'`) or `distanceBudgetInMeters`
 * (for `type: 'distance'`), `travelMode`, optional `departAt`, and the
 * `key=` API-key query parameter.
 *
 * **Travel mode.** `'driving'` (or unset) → `car`. `'walking'` and `'cycling'`
 * raise `unsupported_travel_mode` before any request: TomTom documents that "in
 * calculateReachableRange requests, the values bicycle and pedestrian must not
 * be used" (allowed: car, truck, taxi, bus, van, motorcycle).
 *
 * **Promise.all semantics.** If ANY of the N calls fails the whole
 * `.isochrone` rejects with the first {@link ConnectorError} via
 * `Promise.all`'s reject-on-first-rejection. Per-call retry / partial-success
 * is out of scope at v1.0; consumers wanting partial-success can issue
 * per-band calls themselves.
 *
 * **Cap.** {@link validateIsochroneCap} enforces a 4-value
 * ceiling at the top of `.isochrone`.
 *
 * **Billing note.** Each `values[i]` triggers a billable TomTom call —
 * documented in the per-connector README.
 */
export class TomTomIsochroneConnector
  extends BaseConnector
  implements IIsochroneConnector
{
  readonly providerId = 'tomtom';

  constructor(private config: TomTomConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async isochrone(options: IIsochroneOptions): Promise<IIsochroneResult> {
    validateIsochroneCap(options);
    assertFiniteCoordinate(options.center, 'TomTom isochrone center');

    const baseUrl = `${REACHABLE_RANGE_URL}/${formatCoord(options.center.lat)},${formatCoord(options.center.lng)}/json`;
    const travelMode = this.mapTravelMode(
      options.travelMode as 'driving' | 'walking' | 'cycling' | undefined,
    );

    // Issue one HTTP call per value via Promise.all. `Promise.all` rejects on
    // the first failure — desired.
    const responses = await Promise.all(
      options.values.map((value) =>
        this.fetchOneBand(baseUrl, value, travelMode, options),
      ),
    );

    // Parse + normalize each response. Non-2xx paths are thrown inside
    // fetchOneBand; here we guard the body parse so a 2xx with an empty /
    // non-JSON body surfaces as a ConnectorError, not a raw SyntaxError.
    const datas = await Promise.all(
      responses.map(
        async (resp) =>
          (await resp.json().catch(() => null)) as
            | TomTomReachableRangeResponse
            | null,
      ),
    );

    const contours: IIsochroneContour[] = datas
      .map((data, i) => {
        // An unparseable body, a 2xx without the `reachableRange.boundary`
        // shape, an empty boundary or a point missing a coordinate describes no
        // usable area — a ConnectorError, never a raw TypeError or a (0,0) point.
        const ring = boundaryToRing(data?.reachableRange?.boundary);
        if (ring === null) {
          throw new ConnectorError({
            message: 'TomTom Isochrone returned an unparseable or malformed body',
            statusCode: responses[i]!.status,
            providerCode: 'unknown',
            providerMessage:
              'TomTom Isochrone returned an unparseable or malformed body',
            cause: data,
          });
        }
        // One boundary, so always a Polygon; its winding is normalized like
        // every other provider's rather than trusted.
        return { value: options.values[i]!, geometry: toContourGeometry([[ring]]) };
      })
      .sort((a, b) => a.value - b.value);

    // `_meta` is present iff more than one underlying HTTP call was made
    // (N>1). A single-band request issues exactly one call, so `_meta` is
    // omitted entirely on that path (cross-language convergence).
    return {
      contours,
      raw: datas,
      ...(options.values.length > 1
        ? { _meta: { requestCount: options.values.length } }
        : {}),
    };
  }

  /**
   * Build the query for a single band and dispatch. Throws a
   * {@link ConnectorError} on non-2xx; otherwise returns the resolved
   * `Response` for downstream JSON parsing.
   */
  private async fetchOneBand(
    baseUrl: string,
    value: number,
    travelMode: string,
    options: IIsochroneOptions,
  ): Promise<Response> {
    const baseQuery: Record<string, string> = {
      key: this.config.apiKey,
      travelMode,
    };

    if (options.type === 'time') {
      baseQuery.timeBudgetInSec = String(value);
    } else {
      baseQuery.distanceBudgetInMeters = String(value);
    }

    if (options.departureTime !== undefined && options.departureTime !== '') {
      baseQuery.departAt = options.departureTime;
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(baseUrl, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response);
    }

    return response;
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
      message: `TomTom Isochrone failed: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Map TomTom (HTTP status) → canonical {@link ProviderCode}. TomTom documents
   * 403 as an authorization failure only; its rate limit is 429.
   */
  private mapVendorError(httpStatus: number): ProviderCode {
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readTomTomErrorMessage(body);

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
   * Reachable Range forbids `pedestrian` and `bicycle`, so walking and cycling
   * fail fast here rather than as a vendor 400 per band.
   */
  private mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
      case 'cycling': {
        const message = `TomTom Isochrone (calculateReachableRange) does not support travelMode "${mode}"`;
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
 * TomTom's `reachableRange.boundary` is an array of `{ latitude, longitude }`
 * points. Convert to a `[lng, lat]` ring (closed later by `toContourGeometry`,
 * only if it is not already), or `null` when the boundary is not a non-empty
 * list of points with finite coordinates.
 */
function boundaryToRing(boundary: unknown): number[][] | null {
  if (!Array.isArray(boundary) || boundary.length === 0) return null;
  const ring: number[][] = [];
  for (const point of boundary) {
    if (!isRecord(point) || !isFiniteNumber(point.latitude) || !isFiniteNumber(point.longitude)) {
      return null;
    }
    ring.push([point.longitude, point.latitude]);
  }
  return ring;
}

function readTomTomErrorMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  const errorField = body.error;
  if (errorField !== null && typeof errorField === 'object') {
    const errObj = errorField as Record<string, unknown>;
    const desc = errObj.description;
    if (typeof desc === 'string' && desc !== '') return desc;
    const msg = errObj.message;
    if (typeof msg === 'string' && msg !== '') return msg;
  }
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof errorField === 'string' && errorField !== '') return errorField;
  if (typeof body.detailedError === 'object' && body.detailedError !== null) {
    const detail = body.detailedError as Record<string, unknown>;
    if (typeof detail.message === 'string' && detail.message !== '') return detail.message;
  }
  return null;
}
