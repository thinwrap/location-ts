import { BaseConnector } from '../../base/base.connector';
import type {
  IGeocodingConnector,
  IGeocodeOptions,
  IGeocodeResult,
  IGeocodeCandidate,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  IAutocompleteOptions,
  IAutocompleteResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import type { GoogleConfig } from './google.config';
import type {
  GoogleGeocodeResponse,
  GooglePlacesAutocompleteNewResponse,
} from './google.types';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_AUTOCOMPLETE_NEW_URL =
  'https://places.googleapis.com/v1/places:autocomplete';

/**
 * Google Geocoding + Places Autocomplete NEW connector — per-connector template
 *
 *
 * - Forward/reverse geocode → `GET https://maps.googleapis.com/maps/api/geocode/json`
 *   with `key=` query auth. `countryFilter` translates mechanically into
 * Google's `components=country:XX|country:YY` parameter (outlier per
 * translation lives in this connector, NOT in shared utils).
 * - Autocomplete → `POST https://places.googleapis.com/v1/places:autocomplete`
 *   (Places Autocomplete NEW API) with `X-Goog-Api-Key` header auth and a JSON
 *   body. Different host + auth than the legacy `/place/autocomplete/json`.
 * - In-body `status` inspection mirrors ESRI: HTTP 2xx with `body.status !== 'OK'
 *   && body.status !== 'ZERO_RESULTS'` raises `ConnectorError` with `providerCode`
 * mapped from the in-body status.
 *
 * Retry-After surfacing: parsed seconds appended to `providerMessage` text +
 * raw header value attached to `cause.retryAfter`. No structured
 * `retryAfterSeconds` field on `ConnectorError`
 * by design.
 */
export class GoogleGeocodingConnector
  extends BaseConnector
  implements IGeocodingConnector
{
  readonly providerId = 'google';

  constructor(private config: GoogleConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async geocode(options: IGeocodeOptions): Promise<IGeocodeResult> {
    // mechanical `countryFilter` → `components=country:XX|country:YY`
    // translation. Lives in this connector, not in shared utils. Validate each
    // entry is a 2-letter ISO 3166-1 alpha-2 code before translating, so a stray
    // delimiter (e.g. 'US|CA') cannot corrupt the `components` structure.
    if (options.countryFilter !== undefined) {
      for (const code of options.countryFilter) {
        if (!/^[A-Za-z]{2}$/.test(code)) {
          throw new ConnectorError({
            message: `Invalid countryFilter entry: ${code} (expected ISO 3166-1 alpha-2)`,
            statusCode: null,
            providerCode: 'invalid_request',
            providerMessage: `Invalid countryFilter entry: ${code} (expected ISO 3166-1 alpha-2)`,
          });
        }
      }
    }
    const components = options.countryFilter
      ?.map((code) => `country:${code}`)
      .join('|');

    const query: Record<string, string> = {
      address: options.address,
      key: this.config.apiKey,
    };
    if (components !== undefined && components !== '') {
      query.components = components;
    }
    if (options.language !== undefined) {
      query.language = options.language;
    }

    const merged = mergePassthrough({}, {}, options._passthrough, query);

    const response = await this.sendGet(GEOCODE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    const body = (await response.json().catch(() => null)) as
      | GoogleGeocodeResponse
      | null;

    if (!response.ok) {
      throw this.toConnectorError(response, body, 'Google Geocoding failed');
    }

    this.enforceGoogleStatus(response, body);

    return {
      candidates: (body?.results ?? []).map((r) => normalizeCandidate(r)),
      raw: body,
    };
  }

  async reverseGeocode(
    options: IReverseGeocodeOptions,
  ): Promise<IReverseGeocodeResult> {
    // Fail fast on NaN/non-finite coordinates before a network round-trip.
    // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
    assertFiniteCoordinate(options.location, 'Google reverseGeocode');

    const query: Record<string, string> = {
      latlng: `${options.location.lat},${options.location.lng}`,
      key: this.config.apiKey,
    };
    if (options.language !== undefined) {
      query.language = options.language;
    }

    const merged = mergePassthrough({}, {}, options._passthrough, query);

    const response = await this.sendGet(GEOCODE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    const body = (await response.json().catch(() => null)) as
      | GoogleGeocodeResponse
      | null;

    if (!response.ok) {
      throw this.toConnectorError(
        response,
        body,
        'Google reverse-geocode failed',
      );
    }

    this.enforceGoogleStatus(response, body);

    // reverse-geocode mirrors forward shape (`candidates[]`).
    return {
      candidates: (body?.results ?? []).map((r) => normalizeCandidate(r)),
      raw: body,
    };
  }

  async autocomplete(
    options: IAutocompleteOptions,
  ): Promise<IAutocompleteResult> {
    // Places Autocomplete NEW: POST + JSON body + header auth. Different host
    // from the legacy `/place/autocomplete/json` API.
    const body: Record<string, unknown> = {
      input: options.input,
    };
    if (options.language !== undefined) {
      body.languageCode = options.language;
    }
    if (options.location !== undefined) {
      // Fail fast on NaN/non-finite coordinates before a network round-trip.
      // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
      assertFiniteCoordinate(options.location, 'Google autocomplete');
      const locationBias: Record<string, unknown> = {
        circle: {
          center: {
            latitude: options.location.lat,
            longitude: options.location.lng,
          },
          ...(options.radius !== undefined ? { radius: options.radius } : {}),
        },
      };
      body.locationBias = locationBias;
    }

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
    };

    const merged = mergePassthrough(body, headers, options._passthrough);

    const response = await this.sendPostJson(
      PLACES_AUTOCOMPLETE_NEW_URL,
      merged.body,
      // Honor `_passthrough.query` consistent with forward/reverse geocode.
      { headers: merged.headers, query: merged.query },
    );

    const respBody = (await response.json().catch(() => null)) as
      | GooglePlacesAutocompleteNewResponse
      | null;

    if (!response.ok) {
      // Places NEW returns a Google-style `{ error: { code, message, status } }`
      // envelope, not the legacy `status`/`error_message` shape. Map its fields
      // onto the legacy shape `toConnectorError` reads so the actual vendor
      // message/status drive `providerMessage` and `mapVendorError`.
      throw this.toConnectorError(
        response,
        mapPlacesNewError(respBody),
        'Google Places autocomplete failed',
      );
    }

    const predictions: Array<{ description: string; placeId?: string }> = [];
    for (const s of respBody?.suggestions ?? []) {
      const pred = s.placePrediction;
      if (!pred) continue;
      const entry: { description: string; placeId?: string } = {
        description: pred.text?.text ?? '',
      };
      if (pred.placeId !== undefined) {
        entry.placeId = pred.placeId;
      }
      predictions.push(entry);
    }

    return { predictions, raw: respBody };
  }

  /**
   * Raise `ConnectorError` when HTTP is 2xx but Google's in-body `status` is
   * neither `OK` nor `ZERO_RESULTS`. Mirrors ESRI pattern (in-body error
   * inspection). `ZERO_RESULTS` passes through to return an empty
   * `candidates: []`.
   */
  private enforceGoogleStatus(
    response: Response,
    body: GoogleGeocodeResponse | null,
  ): void {
    const status = body?.status;
    if (status === 'OK' || status === 'ZERO_RESULTS') return;

    throw new ConnectorError({
      message: body?.error_message ?? `Google API returned status: ${status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, status),
      providerMessage: body?.error_message ?? status ?? null,
      cause: body,
    });
  }

  /** Build a `ConnectorError` for a non-2xx HTTP response. */
  private toConnectorError(
    response: Response,
    body: { error_message?: string; status?: string } | null,
    fallbackMessage: string,
  ): ConnectorError {
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null ? { ...(body ?? {}), retryAfter } : body;
    return new ConnectorError({
      message: body?.error_message ?? `${fallbackMessage}: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, body?.status),
      providerMessage: this.formatProviderMessage(
        body?.error_message ?? null,
        retryAfter,
      ),
      cause,
    });
  }

  /**
   * Map (HTTP status, in-body Google status) → canonical {@link ProviderCode}.
   * + combine transport-layer status with Google's in-body
   * `status` field.
   */
  private mapVendorError(
    httpStatus: number,
    googleStatus: string | undefined,
  ): ProviderCode {
    if (googleStatus === 'REQUEST_DENIED') return 'auth_failed';
    if (googleStatus === 'OVER_QUERY_LIMIT') return 'rate_limited';
    if (googleStatus === 'INVALID_REQUEST') return 'invalid_request';

    if (httpStatus === 401) return 'auth_failed';
    if (httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage`, weaving in parsed Retry-After
   * seconds when present. No structured `retryAfterSeconds` field
   * by design.
   */
  private formatProviderMessage(
    base: string | null,
    retryAfter: string | null,
  ): string | null {
    if (retryAfter !== null && retryAfter !== '') {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const suffix = `retry after ${seconds} seconds`;
        return base !== null && base !== '' ? `${base}; ${suffix}` : suffix;
      }
    }
    return base;
  }
}

/**
 * Normalize one Google geocode result row into a unified {@link IGeocodeCandidate}.
 * `viewport` is populated when Google returns one (5/5 native).
 */
function normalizeCandidate(
  r: GoogleGeocodeResponse['results'][number],
): IGeocodeCandidate {
  const candidate: IGeocodeCandidate = {
    formattedAddress: r.formatted_address,
    location: { lat: r.geometry.location.lat, lng: r.geometry.location.lng },
  };
  if (r.place_id !== undefined) {
    candidate.placeId = r.place_id;
  }
  if (r.geometry.viewport !== undefined) {
    candidate.viewport = {
      southwest: {
        lat: r.geometry.viewport.southwest.lat,
        lng: r.geometry.viewport.southwest.lng,
      },
      northeast: {
        lat: r.geometry.viewport.northeast.lat,
        lng: r.geometry.viewport.northeast.lng,
      },
    };
  }
  return candidate;
}

/**
 * Map a Places Autocomplete NEW error envelope `{ error: { message, status } }`
 * onto the legacy `{ error_message, status }` shape consumed by
 * `toConnectorError`. Returns `null` when no recognizable error body is present.
 */
function mapPlacesNewError(
  body: unknown,
): { error_message?: string; status?: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== 'object') return null;
  const result: { error_message?: string; status?: string } = {};
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && message !== '') {
    result.error_message = message;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'string' && status !== '') {
    result.status = status;
  }
  return result;
}
