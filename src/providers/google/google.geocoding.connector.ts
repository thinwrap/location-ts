import { BaseConnector, isErrorBodyUnavailable } from '../../base/base.connector';
import type {
  IGeocodingConnector,
  IGeocodeOptions,
  IGeocodeResult,
  IGeocodeCandidate,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  IAutocompleteOptions,
  IAutocompletePrediction,
  IAutocompleteResult,
  IPlaceDetailsOptions,
  IPlaceDetailsResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { isRecord, malformedResponseError, mergePassthrough, optionalArray } from '../../utils';
import { validatePlaceDetailsOptions } from '../../utils/validate-options';
import { assertFiniteCoordinate, assertFiniteNumber, formatCoord } from '../../utils/coordinate';
import type { GoogleConfig } from './google.config';
import {
  GOOGLE_PLACE_DETAILS_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME,
} from './google.defaults';
import { mapGoogleReason, readGoogleErrorReason } from './google.error-reason';
import type {
  GoogleGeocodeResponse,
  GooglePlacesAutocompleteNewResponse,
} from './google.types';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const PLACES_AUTOCOMPLETE_NEW_URL =
  'https://places.googleapis.com/v1/places:autocomplete';

/**
 * Google Geocoding + Places Autocomplete NEW connector.
 *
 * - Forward/reverse geocode → `GET https://maps.googleapis.com/maps/api/geocode/json`
 *   with `key=` query auth. A single-entry `countryFilter` becomes Google's
 *   `components=country:XX`; more than one entry is refused (see `geocode`).
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
    // `components` filters are ANDed, not ORed: live, `country:US|country:CA`
    // applies only the first country and pads the answer with junk (Windsor →
    // Windsor CT only; CA|US → Windsor ON only; Mississauga + US|CA → [Mississauga
    // ON, "United States" country fallback]). A multi-country filter cannot be
    // honoured, so refuse it rather than silently apply one country.
    if (options.countryFilter !== undefined && options.countryFilter.length > 1) {
      throw new ConnectorError({
        message: 'Google Geocoding does not support more than one countryFilter entry',
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage: `Google Geocoding applies only the first of several components=country: filters; pass a single countryFilter entry (received ${options.countryFilter.length})`,
      });
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
      candidates: normalizeResultList(body, 'Google Geocoding', response.status),
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
      latlng: `${formatCoord(options.location.lat)},${formatCoord(options.location.lng)}`,
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
      candidates: normalizeResultList(body, 'Google reverse-geocode', response.status),
      raw: body,
    };
  }

  /**
   * `countryFilter` (ISO 3166-1 alpha-2) → Autocomplete's
   * `includedRegionCodes`.
   *
   * Not the same translation as forward geocode's `components=country:`. This
   * endpoint documents **ccTLD** two-character values, which diverge from ISO on
   * the United Kingdom — ISO `GB` is ccTLD `uk` — so passing the ISO code
   * through unchanged would silently return no UK predictions rather than
   * erroring. Google also caps the list at 15; over that it rejects the whole
   * request, so we say so locally instead of spending a round-trip to find out.
   */
  private toIncludedRegionCodes(
    countryFilter: string[] | undefined,
  ): string[] | undefined {
    if (countryFilter === undefined || countryFilter.length === 0) {
      return undefined;
    }

    const codes: string[] = [];
    for (const code of countryFilter) {
      if (typeof code !== 'string' || code.trim() === '') continue;
      if (!/^[A-Za-z]{2}$/.test(code)) {
        throw new ConnectorError({
          message: `Invalid countryFilter entry: ${code} (expected ISO 3166-1 alpha-2)`,
          statusCode: null,
          providerCode: 'invalid_request',
          providerMessage: `Invalid countryFilter entry: ${code} (expected ISO 3166-1 alpha-2)`,
        });
      }
      const lower = code.toLowerCase();
      codes.push(lower === 'gb' ? 'uk' : lower);
    }

    if (codes.length === 0) return undefined;
    if (codes.length > 15) {
      throw new ConnectorError({
        message: `Google Autocomplete accepts at most 15 countryFilter entries (received ${codes.length})`,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: `Google Autocomplete accepts at most 15 countryFilter entries (received ${codes.length})`,
      });
    }
    return codes;
  }

  async autocomplete(
    options: IAutocompleteOptions & { sessionToken?: string },
  ): Promise<IAutocompleteResult> {
    // Places Autocomplete NEW: POST + JSON body + header auth. Different host
    // from the legacy `/place/autocomplete/json` API.
    const body: Record<string, unknown> = {
      input: options.input,
    };
    if (options.language !== undefined) {
      body.languageCode = options.language;
    }
    const includedRegionCodes = this.toIncludedRegionCodes(
      options.countryFilter,
    );
    if (includedRegionCodes !== undefined) {
      body.includedRegionCodes = includedRegionCodes;
    }
    // Autocomplete is billed PER SESSION when a session token ties the keystroke
    // requests to the `placeDetails` call that closes them; without one, every
    // keystroke is billed as its own request. Verified live: `sessionToken` is a
    // recognized BODY field here (a bogus name is rejected with
    // INVALID_ARGUMENT), and a QUERY param on Place Details.
    if (options.sessionToken !== undefined) {
      body.sessionToken = options.sessionToken;
    }
    if (options.location !== undefined) {
      // Fail fast on NaN/non-finite coordinates before a network round-trip.
      // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
      assertFiniteCoordinate(options.location, 'Google autocomplete');
      // JSON.stringify turns a NaN radius into `null`.
      if (options.radius !== undefined) assertFiniteNumber(options.radius, 'Google autocomplete radius');
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
        respBody,
      );
    }

    if (!isRecord(respBody)) {
      throw malformedResponseError(
        'Google Places autocomplete',
        'the body is not a JSON object',
        response.status,
        respBody,
      );
    }
    const suggestions = optionalArray(respBody.suggestions);
    if (suggestions === null) {
      throw malformedResponseError(
        'Google Places autocomplete',
        '`suggestions` is not a list',
        response.status,
        respBody,
      );
    }
    const predictions: IAutocompletePrediction[] = [];
    for (const s of suggestions as NonNullable<GooglePlacesAutocompleteNewResponse['suggestions']>) {
      if (!isRecord(s)) continue;
      const pred = s.placePrediction;
      if (!isRecord(pred)) continue;
      const entry: IAutocompletePrediction = {
        description: pred.text?.text ?? '',
      };
      if (pred.placeId !== undefined) {
        entry.placeId = pred.placeId;
      }
      // `structuredFormat` is default-on for Places Autocomplete, so surfacing it
      // costs nothing. Only emitted when Google gives a non-empty main part —
      // never reconstructed by splitting `text`.
      const mainText = pred.structuredFormat?.mainText?.text;
      if (typeof mainText === 'string' && mainText !== '') {
        const secondaryText = pred.structuredFormat?.secondaryText?.text;
        entry.structuredFormat = {
          mainText,
          ...(typeof secondaryText === 'string' && secondaryText !== ''
            ? { secondaryText }
            : {}),
        };
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

  /**
   * Resolve a Google `placeId` to a full candidate.
   *
   * `GET https://places.googleapis.com/v1/places/{placeId}`.
   *
   * Google's Place Details field mask is MANDATORY *and* selects the SKU tier —
   * `displayName` is a Pro-tier field, so it is requested only behind
   * `include: ['name']`. Note this is the opposite of Compute Routes, whose SKU
   * is driven by request *features*: the rule has to be checked per API rather
   * than generalized.
   *
   * Pass the SAME `sessionToken` used for the preceding `autocomplete()` calls to
   * close the session and be billed once for the interaction rather than per
   * keystroke.
   */
  async placeDetails(
    options: IPlaceDetailsOptions & { sessionToken?: string },
  ): Promise<IPlaceDetailsResult> {
    validatePlaceDetailsOptions(options);
    const wantsName = options.include?.includes('name') === true;

    const fieldMask = [
      ...GOOGLE_PLACE_DETAILS_FIELD_MASK,
      ...(wantsName ? GOOGLE_PLACE_DETAILS_FIELD_MASK_NAME : []),
    ].join(',');

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask': fieldMask,
    };

    const query: Record<string, string> = {};
    if (options.language !== undefined) {
      query.languageCode = options.language;
    }
    // A query param here, unlike the autocomplete leg where it is a body field.
    // Verified live on both; a bogus name is rejected either way.
    if (options.sessionToken !== undefined) {
      query.sessionToken = options.sessionToken;
    }

    const merged = mergePassthrough({}, headers, options._passthrough, query);

    const response = await this.sendGet(
      `${PLACE_DETAILS_URL}/${encodeURIComponent(options.placeId)}`,
      { headers: merged.headers, query: merged.query },
    );

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!response.ok) {
      const envelope = mapPlacesNewError(body);
      // Google answers an id it cannot resolve (a closed place, an expired id)
      // with 404 `NOT_FOUND`: no place, not a failure. A malformed id is a 400
      // `INVALID_ARGUMENT` and stays an error below.
      if (
        response.status === 404 &&
        (envelope?.status === undefined || envelope.status === 'NOT_FOUND')
      ) {
        return { candidate: null, raw: body };
      }
      throw this.toConnectorError(
        response,
        envelope,
        'Google Place Details failed',
        body,
      );
    }
    if (body === null) {
      throw new ConnectorError({
        message: 'Google Place Details returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Google Place Details returned a malformed response body',
        cause: body,
      });
    }

    const location = body.location as { latitude?: unknown; longitude?: unknown } | undefined;
    const lat = location?.latitude;
    const lng = location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      // Same rule as the geocode candidates: a place without coordinates is no
      // usable place, never a fabricated (0,0) one.
      return { candidate: null, raw: body };
    }

    const candidate: IGeocodeCandidate = {
      formattedAddress:
        typeof body.formattedAddress === 'string' ? body.formattedAddress : '',
      location: { lat, lng },
    };
    if (typeof body.id === 'string') {
      candidate.placeId = body.id;
    }
    const viewport = body.viewport as
      | { low?: { latitude?: unknown; longitude?: unknown }; high?: { latitude?: unknown; longitude?: unknown } }
      | undefined;
    if (viewport !== undefined) {
      const swLat = viewport.low?.latitude;
      const swLng = viewport.low?.longitude;
      const neLat = viewport.high?.latitude;
      const neLng = viewport.high?.longitude;
      if (
        typeof swLat === 'number' &&
        typeof swLng === 'number' &&
        typeof neLat === 'number' &&
        typeof neLng === 'number'
      ) {
        candidate.viewport = {
          southwest: { lat: swLat, lng: swLng },
          northeast: { lat: neLat, lng: neLng },
        };
      }
    }

    const displayName = (body.displayName as { text?: unknown } | undefined)?.text;

    return {
      candidate,
      ...(wantsName && typeof displayName === 'string' && displayName !== ''
        ? { name: displayName }
        : {}),
      raw: body,
    };
  }

  /**
   * Build a `ConnectorError` for a non-2xx HTTP response.
   *
   * `placesBody` is the undecoded Places (New) error envelope, when there is
   * one. Its `google.rpc.ErrorInfo` reason wins over every status: Places
   * answers an invalid key with HTTP 400 `INVALID_ARGUMENT` + reason
   * `API_KEY_INVALID` (live), which the status mapping would misread as
   * `invalid_request`.
   */
  private toConnectorError(
    response: Response,
    body: { error_message?: string; status?: string } | null,
    fallbackMessage: string,
    placesBody?: unknown,
  ): ConnectorError {
    const retryAfter = response.headers.get('retry-after');
    const cause =
      retryAfter !== null ? { ...(body ?? {}), retryAfter } : body;
    const reasonCode = mapGoogleReason(readGoogleErrorReason(placesBody));
    return new ConnectorError({
      message: body?.error_message ?? `${fallbackMessage}: ${response.status}`,
      statusCode: response.status,
      // `mapVendorError` reads only the envelope status, which a destroyed body
      // cannot supply — so the status-only fallback would confidently return a
      // code it has no evidence for. Say `unknown` instead.
      providerCode:
        reasonCode ??
        (isErrorBodyUnavailable(body)
          ? 'unknown'
          : this.mapVendorError(response.status, body?.status)),
      providerMessage: this.formatProviderMessage(
        body?.error_message ?? null,
        retryAfter,
      ),
      cause,
    });
  }

  /**
   * Map (HTTP status, in-body Google status) → canonical {@link ProviderCode}.
   * The in-body `status` wins: Geocoding reports its failures on HTTP 200.
   */
  private mapVendorError(
    httpStatus: number,
    googleStatus: string | undefined,
  ): ProviderCode {
    // Google's Geocoding statuses, per its documented meanings:
    // `OVER_DAILY_LIMIT` is a key/billing problem ("The API key is missing or
    // invalid. Billing has not been enabled … A self-imposed usage cap has been
    // exceeded. The provided method of payment is no longer valid") — fixed by
    // the account owner, not by waiting — while `OVER_QUERY_LIMIT` is "over
    // your quota". `UNKNOWN_ERROR` is "a server error. The request may succeed
    // if you try again".
    if (googleStatus === 'REQUEST_DENIED') return 'auth_failed';
    if (googleStatus === 'OVER_DAILY_LIMIT') return 'auth_failed';
    if (googleStatus === 'OVER_QUERY_LIMIT') return 'rate_limited';
    if (googleStatus === 'INVALID_REQUEST') return 'invalid_request';
    if (googleStatus === 'UNKNOWN_ERROR') return 'provider_unavailable';

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
 * The candidates of a geocode body whose status already passed
 * `enforceGoogleStatus`. An absent `results` is Google's `ZERO_RESULTS` shape;
 * a `results` that is not a list is a body we cannot read.
 */
function normalizeResultList(
  body: GoogleGeocodeResponse | null,
  label: string,
  statusCode: number,
): IGeocodeCandidate[] {
  const results = optionalArray(body?.results);
  if (results === null) {
    throw malformedResponseError(label, '`results` is not a list', statusCode, body);
  }
  return results
    .map((r) =>
      isRecord(r) ? normalizeCandidate(r as GoogleGeocodeResponse['results'][number]) : null,
    )
    .filter((c): c is IGeocodeCandidate => c !== null);
}

/**
 * Normalize one Google geocode result row into a unified {@link IGeocodeCandidate}.
 * `viewport` is populated when Google returns one (5/5 native).
 *
 * Returns `null` (the caller skips the row) when `geometry.location.lat`/`lng`
 * are absent or non-numeric — never fabricate a Null-Island (0,0) candidate,
 * and never let a missing node surface as a raw `TypeError`. Same null-skip
 * rule as the other four geocoding connectors.
 */
function normalizeCandidate(
  r: GoogleGeocodeResponse['results'][number],
): IGeocodeCandidate | null {
  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const candidate: IGeocodeCandidate = {
    formattedAddress:
      typeof r.formatted_address === 'string' ? r.formatted_address : '',
    location: { lat, lng },
  };
  if (r.place_id !== undefined) {
    candidate.placeId = r.place_id;
  }

  // A partially-populated viewport is dropped whole rather than filled with
  // defaults — a (0,0) corner would silently distort a consumer's map bounds.
  const viewport = r.geometry?.viewport;
  if (viewport !== undefined) {
    const swLat = viewport.southwest?.lat;
    const swLng = viewport.southwest?.lng;
    const neLat = viewport.northeast?.lat;
    const neLng = viewport.northeast?.lng;
    if (
      typeof swLat === 'number' &&
      typeof swLng === 'number' &&
      typeof neLat === 'number' &&
      typeof neLng === 'number'
    ) {
      candidate.viewport = {
        southwest: { lat: swLat, lng: swLng },
        northeast: { lat: neLat, lng: neLng },
      };
    }
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
