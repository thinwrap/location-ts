import { webcrypto } from 'node:crypto';
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
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { MapboxConfig } from './mapbox.config';
import type {
  MapboxGeocodingV6Feature,
  MapboxGeocodingV6Response,
  MapboxSearchboxSuggestResponse,
} from './mapbox.types';

const GEOCODE_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward';
const GEOCODE_REVERSE_URL = 'https://api.mapbox.com/search/geocode/v6/reverse';
const SEARCHBOX_RETRIEVE_URL = 'https://api.mapbox.com/search/searchbox/v1/retrieve';
const SEARCHBOX_SUGGEST_URL =
  'https://api.mapbox.com/search/searchbox/v1/suggest';

/**
 * Mapbox Geocoding connector. Mapbox is an outlier here: forward/reverse and
 * autocomplete live on different endpoints.
 *
 * Forward and reverse geocoding hit Geocoding v6:
 *   - `GET https://api.mapbox.com/search/geocode/v6/forward?q=…`
 *   - `GET https://api.mapbox.com/search/geocode/v6/reverse?longitude=…&latitude=…`
 *
 * Autocomplete hits the separate Searchbox API:
 *   - `GET https://api.mapbox.com/search/searchbox/v1/suggest?q=…&session_token=…`
 *
 * **Session token generation.** Searchbox bills per `/suggest`→`/retrieve`
 * session, correlated by `session_token`. v1.0 generates one UUID per
 * `.autocomplete()` call via `webcrypto.randomUUID()` from `node:crypto`. A
 * consumer can override by passing `_passthrough.query.session_token`; the
 * `mergePassthrough` last-write-wins on `.query` lets the consumer override
 * the generated UUID.
 *
 * **`radius` is documented no-op for Searchbox** (Searchbox lacks a
 * first-class radius parameter); for proximity biasing pass
 * `_passthrough.query.proximity`.
 *
 * Response normalization (Geocoding v6):
 *   - `formattedAddress` ← `properties.full_address` (preferred) or
 *     `place_name` (fallback for older response variants).
 *   - `location` ← `geometry.coordinates[1]` / `[0]` (GeoJSON `[lng, lat]`).
 *   - `placeId` ← `properties.mapbox_id`.
 *   - `viewport` ← `properties.bbox` (`[west, south, east, north]`).
 *
 * Response normalization (Searchbox `/suggest`): map `suggestions[]` to
 * `predictions[]` — `description` from `full_address` or `name`, `placeId`
 * from `mapbox_id`.
 *
 * **Error mapping** mirrors `MapboxRoutingConnector` / `MapboxMatrixConnector`:
 *   - 401/403 → `auth_failed`
 *   - 422     → `invalid_request`
 *   - 429     → `rate_limited`
 *   - 5xx     → `provider_unavailable`
 *
 * **Retry-After.** Surfaced as parsed seconds in `providerMessage` text plus
 * the raw header on `cause.retryAfter` (per / no
 * structured `retryAfterSeconds` field on `ConnectorError`).
 */
export class MapboxGeocodingConnector
  extends BaseConnector
  implements IGeocodingConnector
{
  readonly providerId = 'mapbox';

  constructor(private config: MapboxConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async geocode(options: IGeocodeOptions): Promise<IGeocodeResult> {
    const baseQuery: Record<string, string> = {
      q: options.address,
      access_token: this.config.accessToken,
    };

    if (options.language) baseQuery.language = options.language;

    // `countryFilter` (ISO 3166-1 alpha-2) → Mapbox `country=`
    // (lowercase, comma-separated).
    if (options.countryFilter && options.countryFilter.length > 0) {
      baseQuery.country = options.countryFilter
        .map((code) => code.toLowerCase())
        .join(',');
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(GEOCODE_FORWARD_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.buildVendorError(response, 'Mapbox geocoding failed');
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxGeocodingV6Response
      | null;
    if (data === null) {
      throw this.malformedBodyError('geocoding', response.status);
    }
    return {
      candidates: (data.features ?? [])
        .map(normalizeFeature)
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async reverseGeocode(
    options: IReverseGeocodeOptions,
  ): Promise<IReverseGeocodeResult> {
    // Fail fast on NaN/non-finite coordinates before a network round-trip.
    // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
    assertFiniteCoordinate(options.location, 'Mapbox reverseGeocode');

    const baseQuery: Record<string, string> = {
      longitude: formatCoord(options.location.lng),
      latitude: formatCoord(options.location.lat),
      access_token: this.config.accessToken,
    };

    if (options.language) baseQuery.language = options.language;

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(GEOCODE_REVERSE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.buildVendorError(
        response,
        'Mapbox reverse geocoding failed',
      );
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxGeocodingV6Response
      | null;
    if (data === null) {
      throw this.malformedBodyError('reverse geocoding', response.status);
    }
    // reverse-geocode mirrors forward shape — return all ranked
    // candidates, not just the first feature.
    return {
      candidates: (data.features ?? [])
        .map(normalizeFeature)
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async autocomplete(
    options: IAutocompleteOptions,
  ): Promise<IAutocompleteResult> {
    // Searchbox requires a `session_token`. Generate a UUID per call;
    // the consumer may override via `_passthrough.query.session_token` thanks
    // to `mergePassthrough`'s last-write-wins on query.
    const baseQuery: Record<string, string> = {
      q: options.input,
      access_token: this.config.accessToken,
      session_token: generateSessionToken(),
    };

    if (options.language) baseQuery.language = options.language;

    // `countryFilter` (ISO 3166-1 alpha-2) → Searchbox `country=`
    // (lowercase, comma-separated), same translation as forward geocode.
    if (options.countryFilter && options.countryFilter.length > 0) {
      baseQuery.country = options.countryFilter
        .map((code) => code.toLowerCase())
        .join(',');
    }

    // `radius` is a documented no-op for Searchbox (no first-class radius).
    // For proximity biasing the consumer passes `_passthrough.query.proximity`.

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(SEARCHBOX_SUGGEST_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.buildVendorError(response, 'Mapbox autocomplete failed');
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxSearchboxSuggestResponse
      | null;
    if (data === null) {
      throw this.malformedBodyError('autocomplete', response.status);
    }
    return {
      predictions: (data.suggestions ?? []).map((s) => {
        const prediction: IAutocompletePrediction = {
          description: s.full_address ?? s.name ?? '',
          ...(s.mapbox_id !== undefined ? { placeId: s.mapbox_id } : {}),
        };
        // Search Box returns `name` (the POI/street) and `place_formatted` (the
        // rest of the address) as separate fields.
        if (typeof s.name === 'string' && s.name !== '') {
          prediction.structuredFormat = {
            mainText: s.name,
            ...(typeof s.place_formatted === 'string' && s.place_formatted !== ''
              ? { secondaryText: s.place_formatted }
              : {}),
          };
        }
        return prediction;
      }),
      raw: data,
    };
  }

  /**
   * Build a typed ConnectorError for a 2xx response whose body failed to parse
   * (empty / non-JSON), so a raw SyntaxError never escapes the connector.
   */
  /**
   * Resolve a Mapbox `mapbox_id` to a full candidate.
   *
   * `GET https://api.mapbox.com/search/searchbox/v1/retrieve/{mapbox_id}`.
   *
   * Pass the SAME `sessionToken` used for the preceding `autocomplete()` call:
   * Search Box bills per *session*, so a matching token makes suggest+retrieve one
   * billable session and a missing or fresh one makes it two.
   */
  async placeDetails(
    options: IPlaceDetailsOptions & { sessionToken?: string },
  ): Promise<IPlaceDetailsResult> {
    const query: Record<string, string> = {
      access_token: this.config.accessToken,
    };
    if (options.sessionToken !== undefined) {
      query.session_token = options.sessionToken;
    }
    if (options.language !== undefined) {
      query.language = options.language;
    }

    const merged = mergePassthrough({}, {}, options._passthrough, query);
    const response = await this.sendGet(
      `${SEARCHBOX_RETRIEVE_URL}/${encodeURIComponent(options.placeId)}`,
      { headers: merged.headers, query: merged.query },
    );

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      throw new ConnectorError({
        message: `Mapbox Place Details failed: ${response.status}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status),
        providerMessage: `Mapbox Place Details failed: ${response.status}`,
        cause: errBody,
      });
    }

    const data = (await response.json().catch(() => null)) as
      | MapboxGeocodingV6Response
      | null;
    if (data === null) {
      throw this.malformedBodyError('place details', response.status);
    }

    // Retrieve returns a GeoJSON FeatureCollection, the same shape as v6 geocode —
    // so it reuses the geocode normalizer rather than duplicating it.
    const feature = data.features?.[0];
    const candidate = feature !== undefined ? normalizeFeature(feature) : null;
    if (candidate === null) {
      throw new ConnectorError({
        message: 'Mapbox Place Details returned no feature',
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage: 'Mapbox Place Details returned no feature',
        cause: data,
      });
    }

    const wantsName = options.include?.includes('name') === true;
    const name = feature?.properties?.name;
    return {
      candidate,
      ...(wantsName && typeof name === 'string' && name !== '' ? { name } : {}),
      raw: data,
    };
  }

  private malformedBodyError(
    operation: string,
    statusCode: number,
  ): ConnectorError {
    const message = `Mapbox ${operation} returned a malformed response body`;
    return new ConnectorError({
      message,
      statusCode,
      providerCode: 'unknown',
      providerMessage: message,
    });
  }

  /**
   * Read the vendor response and turn it into a `ConnectorError`. Mirrors the
   * Retry-After surface used by `MapboxMatrixConnector` — parsed seconds
   * inside `providerMessage`, raw header on `cause.retryAfter`.
   */
  private async buildVendorError(
    response: Response,
    defaultMessage: string,
  ): Promise<ConnectorError> {
    const errorBody = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null ? { ...(errorBody ?? {}), retryAfter } : errorBody;

    const providerMessage = this.formatProviderMessage(errorBody, retryAfter);
    const message =
      providerMessage !== null
        ? providerMessage
        : `${defaultMessage}: HTTP ${response.status}`;

    return new ConnectorError({
      message,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status),
      providerMessage,
      cause,
    });
  }

  /**
   * Map HTTP status → canonical {@link ProviderCode}. 7
   * (Mapbox routing).
   */
  private mapVendorError(httpStatus: number): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 422) return 'invalid_request';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage`, weaving in parsed Retry-After
   * seconds. By design there is no structured `retryAfterSeconds` field on
   * `ConnectorError`.
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readMessage(body);

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

function normalizeFeature(f: MapboxGeocodingV6Feature): IGeocodeCandidate | null {
  const coords = f.geometry?.coordinates;
  // GeoJSON [lng, lat] order. Do NOT fabricate a (0,0) "Null Island" location
  // when coordinates are absent (v6 should always populate them); skip the
  // feature instead so a consumer cannot mistake a defensive default for a
  // real result.
  const lng = coords?.[0];
  const lat = coords?.[1];
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const candidate: IGeocodeCandidate = {
    formattedAddress: f.properties?.full_address ?? f.place_name ?? '',
    location: { lat, lng },
  };

  if (f.properties?.mapbox_id !== undefined) {
    candidate.placeId = f.properties.mapbox_id;
  }

  const bbox = f.properties?.bbox;
  if (
    bbox !== undefined &&
    bbox.length === 4 &&
    bbox.every((n) => typeof n === 'number')
  ) {
    candidate.viewport = {
      southwest: { lat: bbox[1], lng: bbox[0] },
      northeast: { lat: bbox[3], lng: bbox[2] },
    };
  }

  return candidate;
}

function readMessage(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  if (typeof body.message === 'string' && body.message !== '') {
    return body.message;
  }
  if (typeof body.error === 'string' && body.error !== '') return body.error;
  return null;
}

/**
 * Generate a Searchbox session token. Uses `webcrypto.randomUUID()` from
 * `node:crypto` — available on Node 18, unlike the global `crypto`, which is
 * only exposed on Node 19+. Extracted as a module-level function so the spec
 * can mock it via `vi.spyOn(webcrypto, 'randomUUID')`.
 */
function generateSessionToken(): string {
  return webcrypto.randomUUID();
}
