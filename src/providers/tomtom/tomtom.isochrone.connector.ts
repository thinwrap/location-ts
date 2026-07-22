import type { Polygon } from 'geojson';
import { BaseConnector } from '../../base/base.connector';
import type {
  IIsochroneConnector,
  IIsochroneContour,
  IIsochroneOptions,
  IIsochroneResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { mergePassthrough, validateIsochroneCap } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { TomTomConfig } from './tomtom.config';
import type { TomTomReachableRangeResponse } from './tomtom.types';

const REACHABLE_RANGE_URL = 'https://api.tomtom.com/routing/1/calculateReachableRange';

/**
 * TomTom Reachable Range connector — architectural outlier #5 in
 * *
 * TomTom's `calculateReachableRange` API takes only ONE budget value per call;
 * multi-band isochrones therefore require N parallel HTTP calls. Per
 * the N-call assembly lives inside this connector. This is the only connector
 * that populates `result._meta` — and only when N>1 (multi-band). A single-band
 * request is a single HTTP call and omits `_meta` entirely.
 *
 * **Wire shape.** `GET https://api.tomtom.com/routing/1/calculateReachableRange/{lat},{lng}/json`
 * with `timeBudgetInSec` (for `type: 'time'`) or `distanceBudgetInMeters`
 * (for `type: 'distance'`), `travelMode`, optional `departAt`, and the
 * `key=` API-key query parameter.
 *
 * **Travel mode mapping** with cycling per `IsochroneOptionsMap['tomtom']`
 * augmentation in `tomtom.types.ts`:
 * `'driving'` → `car`.
 * `'walking'` → `pedestrian`.
 * `'cycling'` → `bicycle`.
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
    // non-JSON body surfaces as a ConnectorError, not a raw SyntaxError (#109).
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
        // Guard against an unparseable body (#109) or a 2xx that lacks the
        // `reachableRange.boundary` shape (#82) — surface as ConnectorError
        // rather than a raw SyntaxError / TypeError.
        const boundary = data?.reachableRange?.boundary;
        if (!Array.isArray(boundary)) {
          throw new ConnectorError({
            message: 'TomTom Isochrone returned an unparseable or malformed body',
            statusCode: null,
            providerCode: 'unknown',
            providerMessage:
              'TomTom Isochrone returned an unparseable or malformed body',
            cause: data,
          });
        }
        return {
          value: options.values[i]!,
          geometry: boundaryToPolygon(boundary),
        };
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
   * Map TomTom (HTTP status) → canonical {@link ProviderCode}. Mirrors
   * */
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

  private mapTravelMode(mode?: 'driving' | 'walking' | 'cycling'): string {
    switch (mode) {
      case 'walking':
        return 'pedestrian';
      case 'cycling':
        return 'bicycle';
      default:
        return 'car';
    }
  }
}

/**
 * TomTom's `reachableRange.boundary` is an open array of
 * `{ latitude, longitude }` points. Convert to a closed GeoJSON Polygon ring
 * with `[lng, lat]` order.
 */
function boundaryToPolygon(
  boundary: Array<{ latitude: number; longitude: number }>,
): Polygon {
  const ring: number[][] = boundary.map((p) => [p.longitude, p.latitude]);
  if (ring.length > 0 && boundary[0] !== undefined) {
    const first = ring[0]!;
    ring.push([first[0]!, first[1]!]);
  }
  return { type: 'Polygon', coordinates: [ring] };
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
