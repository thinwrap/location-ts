import { BaseConnector } from '../../base/base.connector';
import type {
  IGeocodingConnector,
  IGeocodeOptions,
  IGeocodeResult,
  IGeocodeCandidate,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  IAutocompleteOptions,
  IAutocompletePrediction,
  IPlaceDetailsOptions,
  IPlaceDetailsResult,
  IAutocompleteResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { TomTomConfig } from './tomtom.config';
import type {
  TomTomGeocodeResponse,
  TomTomReverseGeocodeResponse,
  TomTomSearchResponse,
} from './tomtom.types';

const GEOCODE_URL = 'https://api.tomtom.com/search/2/geocode';
const REVERSE_GEOCODE_URL = 'https://api.tomtom.com/search/2/reverseGeocode';
const SEARCH_URL = 'https://api.tomtom.com/search/2/search';
const PLACE_BY_ID_URL = 'https://api.tomtom.com/search/2/place.json';

/**
 * TomTom Search v2 connector — Geocoding.
 *
 * Forward geocode: `GET /search/2/geocode/<address>.json` (address in the URL
 * path, NOT a `q=` query param — minor URL construction wrinkle versus other
 * providers).
 *
 * Reverse geocode: `GET /search/2/reverseGeocode/<lat>,<lng>.json`.
 *
 * Autocomplete: `GET /search/2/search/<input>.json?typeahead=true` (TomTom's
 * Fuzzy Search with `typeahead=true` is the autocomplete pathway).
 *
 * **Country filter.** `countryFilter: string[]` → TomTom's
 * `countrySet=<comma-csv>` parameter on forward geocode.
 *
 * **Viewport conversion.** TomTom returns
 * `viewport: { topLeftPoint, btmRightPoint }` with NW + SE corners; the
 * normalizer converts to the unified `{ southwest, northeast }` shape:
 * - `southwest.lat = btmRightPoint.lat` (south)
 * - `southwest.lng = topLeftPoint.lon` (west)
 * - `northeast.lat = topLeftPoint.lat` (north)
 * - `northeast.lng = btmRightPoint.lon` (east)
 *
 * **`mapVendorError`**: 400 → `invalid_request`,
 * 401/403 → `auth_failed`, 429 → `rate_limited`, 5xx → `provider_unavailable`.
 * Retry-After surfaced via parsed seconds in `providerMessage` + raw
 * `cause.retryAfter` by design.
 */
export class TomTomGeocodingConnector
  extends BaseConnector
  implements IGeocodingConnector
{
  readonly providerId = 'tomtom';

  constructor(private config: TomTomConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async geocode(options: IGeocodeOptions): Promise<IGeocodeResult> {
    // TomTom carries the query in the URL path, not a `q=` param — an empty
    // address would build the malformed `/geocode/.json` URL (#130). Reject
    // pre-flight rather than round-tripping an opaque provider 400/404.
    if (options.address === '') {
      throw new ConnectorError({
        message: 'TomTom Geocoding requires a non-empty address',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'TomTom Geocoding requires a non-empty address',
      });
    }

    const url = `${GEOCODE_URL}/${encodeURIComponent(options.address)}.json`;

    const baseQuery: Record<string, string> = {
      key: this.config.apiKey,
    };

    if (options.language !== undefined && options.language !== '') {
      baseQuery.language = options.language;
    }
    // `countryFilter` (ISO 3166-1 alpha-2) → TomTom `countrySet` CSV.
    if (options.countryFilter && options.countryFilter.length > 0) {
      baseQuery.countrySet = options.countryFilter.join(',');
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

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Geocoding');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomGeocodeResponse
      | null;
    if (data === null) throw malformedBodyError(response.status, data);
    return {
      candidates: (data.results ?? [])
        .map((r) => normalizeCandidate(r))
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async reverseGeocode(
    options: IReverseGeocodeOptions,
  ): Promise<IReverseGeocodeResult> {
    // Fail fast on NaN/non-finite coordinates before a network round-trip.
    // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
    assertFiniteCoordinate(options.location, 'TomTom reverseGeocode');

    const url = `${REVERSE_GEOCODE_URL}/${formatCoord(options.location.lat)},${formatCoord(options.location.lng)}.json`;

    const baseQuery: Record<string, string> = {
      key: this.config.apiKey,
    };

    if (options.language !== undefined && options.language !== '') {
      baseQuery.language = options.language;
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

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Reverse Geocoding');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomReverseGeocodeResponse
      | null;
    if (data === null) throw malformedBodyError(response.status, data);

    // reverse-geocode mirrors forward shape — `candidates[]`.
    // TomTom encodes reverse-geocode position as a `"lat,lng"` string.
    return {
      candidates: (data.addresses ?? []).flatMap((a) =>
        normalizeReverseCandidate(a),
      ),
      raw: data,
    };
  }

  async autocomplete(
    options: IAutocompleteOptions,
  ): Promise<IAutocompleteResult> {
    // Input is carried in the URL path — an empty input builds the malformed
    // `/search/.json` URL (#130). Reject pre-flight.
    if (options.input === '') {
      throw new ConnectorError({
        message: 'TomTom Autocomplete requires a non-empty input',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'TomTom Autocomplete requires a non-empty input',
      });
    }

    const url = `${SEARCH_URL}/${encodeURIComponent(options.input)}.json`;

    const baseQuery: Record<string, string> = {
      key: this.config.apiKey,
      typeahead: 'true',
      limit: '5',
    };

    if (options.language !== undefined && options.language !== '') {
      baseQuery.language = options.language;
    }
    if (options.location !== undefined) {
      assertFiniteCoordinate(options.location, 'TomTom autocomplete location');
      baseQuery.lat = formatCoord(options.location.lat);
      baseQuery.lon = formatCoord(options.location.lng);
    }
    if (options.radius !== undefined) {
      baseQuery.radius = String(options.radius);
    }
    // `countryFilter` (ISO 3166-1 alpha-2) → TomTom `countrySet=<comma-csv>`,
    // same translation as forward geocode.
    if (options.countryFilter && options.countryFilter.length > 0) {
      baseQuery.countrySet = options.countryFilter.join(',');
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

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Autocomplete');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomSearchResponse
      | null;
    if (data === null) throw malformedBodyError(response.status, data);
    return {
      predictions: (data.results ?? []).map((r) => {
        const prediction: IAutocompletePrediction = {
          description: r.poi?.name
            ? `${r.poi.name}, ${r.address.freeformAddress}`
            : r.address.freeformAddress,
          // placeId is optional; set it only when the vendor returns an
          // id rather than emitting `placeId: undefined` as an own-property (#146).
          ...(r.id !== undefined ? { placeId: r.id } : {}),
        };
        // Live-verified: `poi.name` is undefined for street/address results, which
        // have no distinct main part. Omit the whole object there rather than
        // splitting `freeformAddress` on a comma, which would be a guess.
        if (typeof r.poi?.name === 'string' && r.poi.name !== '') {
          const secondaryText = r.address?.freeformAddress;
          prediction.structuredFormat = {
            mainText: r.poi.name,
            ...(typeof secondaryText === 'string' && secondaryText !== ''
              ? { secondaryText }
              : {}),
          };
        }
        return prediction;
      }),
      raw: data,
    };
  }

  /**
   * Resolve a TomTom result id to a full candidate.
   *
   * `GET https://api.tomtom.com/search/2/place.json?entityId=` — a plain lookup,
   * no per-session billing concept.
   */
  async placeDetails(options: IPlaceDetailsOptions): Promise<IPlaceDetailsResult> {
    const query: Record<string, string> = {
      key: this.config.apiKey,
      entityId: options.placeId,
    };
    if (options.language !== undefined) {
      query.language = options.language;
    }

    const merged = mergePassthrough({}, {}, options._passthrough, query);
    const response = await this.sendGet(PLACE_BY_ID_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'TomTom Place Details');
    }

    const data = (await response.json().catch(() => null)) as
      | TomTomGeocodeResponse
      | null;
    if (data === null) throw malformedBodyError(response.status, data);

    const result = data.results?.[0];
    const candidate = result !== undefined ? normalizeCandidate(result) : null;
    if (candidate === null) {
      throw new ConnectorError({
        message: 'TomTom Place Details returned no result',
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage: 'TomTom Place Details returned no result',
        cause: data,
      });
    }

    const wantsName = options.include?.includes('name') === true;
    const poiName = result?.poi?.name;
    return {
      candidate,
      ...(wantsName && typeof poiName === 'string' && poiName !== ''
        ? { name: poiName }
        : {}),
      raw: data,
    };
  }

  private async raiseHttpError(
    response: Response,
    label: string,
  ): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null
        ? { ...(errorBody ?? {}), retryAfter }
        : errorBody;
    return new ConnectorError({
      message: `${label} failed: ${response.status}`,
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
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Surface a 2xx response whose body is empty / non-JSON as a
 * {@link ConnectorError} rather than letting a raw `SyntaxError` escape (#129).
 * Mirrors the isochrone connector's malformed-body guard with `'unknown'`.
 */
function malformedBodyError(
  statusCode: number,
  data: unknown,
): ConnectorError {
  return new ConnectorError({
    message: 'TomTom returned a non-JSON/unparseable body',
    statusCode,
    providerCode: 'unknown',
    providerMessage: 'TomTom returned a non-JSON/unparseable body',
    cause: data,
  });
}

/**
 * Normalize a single forward-geocode result feature into the unified
 * {@link IGeocodeCandidate} shape. Converts TomTom's
 * `viewport: { topLeftPoint, btmRightPoint }` (NW + SE corners) into the
 * unified `{ southwest, northeast }` shape.
 */
function normalizeCandidate(r: {
  id?: string;
  address: { freeformAddress: string };
  position: { lat: number; lon: number };
  viewport?: {
    topLeftPoint?: { lat: number; lon: number };
    btmRightPoint?: { lat: number; lon: number };
  };
}): IGeocodeCandidate | null {
  // Skip a result without real coordinates rather than emitting a fabricated
  // (0,0) candidate or letting a missing `position` surface as a raw TypeError.
  const lat = r.position?.lat;
  const lng = r.position?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const candidate: IGeocodeCandidate = {
    formattedAddress: r.address?.freeformAddress ?? '',
    location: { lat, lng },
  };
  if (r.id !== undefined) candidate.placeId = r.id;

  const tl = r.viewport?.topLeftPoint;
  const br = r.viewport?.btmRightPoint;
  if (
    tl !== undefined &&
    br !== undefined &&
    typeof tl.lat === 'number' &&
    typeof tl.lon === 'number' &&
    typeof br.lat === 'number' &&
    typeof br.lon === 'number'
  ) {
    candidate.viewport = {
      southwest: { lat: br.lat, lng: tl.lon },
      northeast: { lat: tl.lat, lng: br.lon },
    };
  }
  return candidate;
}

/**
 * Normalize a single reverse-geocode `addresses[]` entry into a
 * {@link IGeocodeCandidate}. Returns `[]` (dropping the candidate) when the
 * entry lacks a usable `position` or `address` rather than fabricating a
 * Null Island (0,0) coordinate (#120, #145) or emitting silent NaN from a
 * malformed `"lat,lng"` string (#131). `placeId` is set only when present.
 */
function normalizeReverseCandidate(a: {
  address?: { freeformAddress: string };
  position?: string;
  id?: string;
}): IGeocodeCandidate[] {
  if (a.address === undefined || typeof a.position !== 'string') return [];

  const parts = a.position.split(',');
  if (parts.length !== 2) return [];
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const candidate: IGeocodeCandidate = {
    formattedAddress: a.address.freeformAddress,
    location: { lat, lng },
  };
  if (a.id !== undefined) candidate.placeId = a.id;
  return [candidate];
}

function readTomTomErrorMessage(
  body: Record<string, unknown> | null,
): string | null {
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
  if (typeof body.errorText === 'string' && body.errorText !== '') {
    return body.errorText;
  }
  return null;
}
