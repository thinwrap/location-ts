import { BaseConnector } from '../../base/base.connector';
import type {
  IAutocompleteOptions,
  IAutocompleteResult,
  IPlaceDetailsOptions,
  IPlaceDetailsResult,
  IGeocodeCandidate,
  IGeocodeOptions,
  IGeocodeResult,
  IGeocodingConnector,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  ProviderCode,
} from '../../types';
import { ConnectorError } from '../../types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { EsriConfig } from './esri.config';
import { resolveEsriBearerToken } from './esri.config';
import type {
  EsriGeocodeResponse,
  EsriReverseGeocodeResponse,
  EsriSuggestResponse,
} from './esri.types';

const GEOCODE_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const REVGEOCODE_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode';
const SUGGEST_URL =
  'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest';

/**
 * ESRI (ArcGIS) World Geocoding Service connector. Shares ESRI's dual-auth and
 * 200-with-error-body handling with the Routing and Matrix connectors.
 *
 * **Three endpoints under `GeocodeServer/`:**
 * - `findAddressCandidates` for forward geocoding (multi-result natively).
 * - `reverseGeocode` for reverse geocoding (**single-result natively** — the
 *   connector wraps the single result in a one-element `candidates[]` array
 *).
 * - `suggest` for autocomplete (`magicKey` → unified `placeId`).
 *
 * Dual-auth ({@link EsriConfig} `apiKey` XOR `arcgisToken`) is resolved via
 * {@link resolveEsriBearerToken} and forwarded on the `token=` query
 * parameter
 *
 * **ESRI's 200-with-error-body quirk:** ArcGIS REST services frequently
 * return HTTP 200 OK with an `error: { code, message }` body for
 * application-layer failures (invalid token, malformed query). This connector
 * inspects the body even on success status codes and throws a
 * {@link ConnectorError} via {@link EsriGeocodingConnector.mapVendorError}.
 *
 * **reverse-geocode wrap:** ESRI is the 1/5 provider that
 * returns a single result on `reverseGeocode`. We wrap it in
 * `candidates: [{ formattedAddress, location, placeId: undefined,
 * viewport: undefined }]` so the consumer-facing contract is uniform across
 * all five geocoding providers.
 *
 * Retry-After surfacing: parsed seconds in `providerMessage` + raw header in
 * `cause.retryAfter` by design (no
 * structured `retryAfterSeconds` field on `ConnectorError`).
 *
 * Token lifecycle (~120 min for `arcgisToken`) is consumer-owned (the wrapper holds no state); documented in the per-connector README.
 */
export class EsriGeocodingConnector
  extends BaseConnector
  implements IGeocodingConnector
{
  readonly providerId = 'esri';

  constructor(private config: EsriConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async geocode(options: IGeocodeOptions): Promise<IGeocodeResult> {
    // forward geocode → findAddressCandidates with singleLine + token,
    // `outFields=*` to surface viewport `extent`, optional `countryCode` from
    // `countryFilter` (comma-joined alpha-2; ESRI uses alpha-2 directly).
    const baseQuery: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      singleLine: options.address,
      outFields: '*',
    };

    if (options.countryFilter !== undefined && options.countryFilter.length > 0) {
      baseQuery.countryCode = options.countryFilter.join(',');
    }
    if (options.language !== undefined) {
      baseQuery.langCode = options.language;
    }

    const data = await this.dispatchGet<EsriGeocodeResponse>(
      GEOCODE_URL,
      baseQuery,
      options._passthrough,
      'ESRI geocoding failed',
    );

    return {
      candidates: (data.candidates ?? [])
        .map((c) => this.normalizeForwardCandidate(c))
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async reverseGeocode(
    options: IReverseGeocodeOptions,
  ): Promise<IReverseGeocodeResult> {
    // Fail fast on NaN/non-finite coordinates before a network round-trip.
    // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
    assertFiniteCoordinate(options.location, 'ESRI reverseGeocode');

    // reverse geocode → single result wrapped in candidates[].
    const baseQuery: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      // ESRI accepts `location=<lng>,<lat>` (lng-first per ESRI x/y convention).
      location: `${formatCoord(options.location.lng)},${formatCoord(options.location.lat)}`,
    };

    if (options.language !== undefined) {
      baseQuery.langCode = options.language;
    }

    const data = await this.dispatchGet<EsriReverseGeocodeResponse>(
      REVGEOCODE_URL,
      baseQuery,
      options._passthrough,
      'ESRI reverse geocoding failed',
    );

    // when ESRI surfaces no address/location, return an empty
    // candidates[] (parity with the other 4 providers' empty result shape).
    if (data.address === undefined || data.location === undefined) {
      return { candidates: [], raw: data };
    }

    const formattedAddress =
      data.address.LongLabel ?? data.address.Match_addr;
    if (formattedAddress === undefined || formattedAddress === '') {
      return { candidates: [], raw: data };
    }

    // wrap: 1 element. `placeId` is `undefined` because reverseGeocode
    // lacks a stable opaque ID; `viewport` is `undefined` because ESRI's
    // reverse endpoint does not return an `extent`.
    // No coordinates means no usable candidate — never a fabricated (0,0).
    const y = data.location?.y;
    const x = data.location?.x;
    if (typeof y !== 'number' || typeof x !== 'number') {
      return { candidates: [], raw: data };
    }

    return {
      candidates: [
        {
          formattedAddress,
          location: { lat: y, lng: x },
        },
      ],
      raw: data,
    };
  }

  async autocomplete(
    options: IAutocompleteOptions,
  ): Promise<IAutocompleteResult> {
    // suggest → predictions. `radius` and `language` are documented
    // no-ops per ESRI's `/suggest` surface (no per-request language flag and
    // no first-class radius bias).
    const baseQuery: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      text: options.input,
    };

    if (options.location !== undefined) {
      baseQuery.location = `${formatCoord(options.location.lng)},${formatCoord(options.location.lat)}`;
    }
    // `countryFilter` → `countryCode` (comma-joined alpha-2; ESRI uses alpha-2
    // directly), same translation as forward geocode.
    if (options.countryFilter !== undefined && options.countryFilter.length > 0) {
      baseQuery.countryCode = options.countryFilter.join(',');
    }

    const data = await this.dispatchGet<EsriSuggestResponse>(
      SUGGEST_URL,
      baseQuery,
      options._passthrough,
      'ESRI autocomplete failed',
    );

    return {
      predictions: (data.suggestions ?? []).map((s) => ({
        description: s.text,
        // magicKey → placeId (ESRI's "most stable per-result
        // identifier" convention from the architecture).
        placeId: s.magicKey,
      })),
      raw: data,
    };
  }

  /**
   * Shared GET dispatch + body inspection used by all three geocoding methods.
   * Funnels both HTTP-level errors and 200-with-error-body through
   * {@link EsriGeocodingConnector.raiseHttpError} /
   * {@link EsriGeocodingConnector.raiseBodyError}.
   */
  /**
   * Resolve an Esri `magicKey` (from `autocomplete()`) to a full candidate.
   *
   * `GET .../findAddressCandidates?magicKey=` — the same endpoint as forward
   * geocode, so the same normalizer applies.
   *
   * **Live-verified that `magicKey` alone is sufficient.** Esri's docs pair it
   * with the original `SingleLine` text, and the plan here originally did too;
   * probing showed the key on its own resolves to the byte-identical candidate.
   * That is why `placeId` needs no companion field and Esri needs no narrowed
   * input — our `placeId` IS the magicKey.
   */
  async placeDetails(options: IPlaceDetailsOptions): Promise<IPlaceDetailsResult> {
    const baseQuery: Record<string, string> = {
      f: 'json',
      token: resolveEsriBearerToken(this.config),
      magicKey: options.placeId,
      outFields: '*',
    };
    if (options.language !== undefined) {
      baseQuery.langCode = options.language;
    }

    const data = await this.dispatchGet<EsriGeocodeResponse>(
      GEOCODE_URL,
      baseQuery,
      options._passthrough,
      'ESRI place details failed',
    );

    const first = data.candidates?.[0];
    const candidate = first !== undefined ? this.normalizeForwardCandidate(first) : null;
    if (candidate === null) {
      throw new ConnectorError({
        message: 'ESRI Place Details returned no candidate',
        statusCode: null,
        providerCode: 'no_route',
        providerMessage: 'ESRI Place Details returned no candidate',
        cause: data,
      });
    }

    // Esri returns only an address — there is no separate display name to
    // surface, so `name` stays absent even when requested.
    return { candidate, raw: data };
  }

  private async dispatchGet<T extends { error?: { message: string; code: number } }>(
    url: string,
    baseQuery: Record<string, string>,
    passthrough: IGeocodeOptions['_passthrough'],
    failureLabel: string,
  ): Promise<T> {
    // mergePassthrough 3-arg form (positional: connectorBody, connectorHeaders,
    // passthrough). we route the wire params via `body` then
    // shift them into the URL query string for the GET request, alongside
    // any `passthrough.query` overrides.
    const merged = mergePassthrough(
      baseQuery as unknown as Record<string, unknown>,
      {},
      passthrough,
    );

    const finalQuery: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged.body)) {
      if (value !== undefined && value !== null) {
        finalQuery[key] = stringifyQueryValue(value);
      }
    }
    for (const [key, value] of Object.entries(merged.query)) {
      finalQuery[key] = value;
    }

    const response = await this.sendGet(url, {
      headers: merged.headers,
      query: finalQuery,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, failureLabel);
    }

    const data = (await response.json().catch(() => null)) as T | null;
    if (data === null || typeof data !== 'object') {
      throw new ConnectorError({
        message: `${failureLabel}: non-JSON body`,
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: `${failureLabel}: non-JSON body`,
      });
    }

    // ESRI 200-with-error-body inspection.
    if (data.error !== undefined && data.error !== null) {
      throw this.raiseBodyError(data, response.status, failureLabel);
    }

    return data;
  }

  /**
   * Map an ESRI forward candidate to the unified {@link IGeocodeCandidate}
   * shape. `viewport` is derived from `extent` when present; `placeId`
   * is intentionally `undefined` because `findAddressCandidates` does not
   * carry a stable per-result identifier (its `attributes.UniqueID` is
   * service-version-dependent and not portable).
   */
  private normalizeForwardCandidate(
    c: EsriGeocodeResponse['candidates'][number],
  ): IGeocodeCandidate | null {
    // Skip a candidate without real coordinates rather than emitting a fabricated
    // (0,0) location or letting a missing `location` surface as a raw TypeError.
    const y = c.location?.y;
    const x = c.location?.x;
    if (typeof y !== 'number' || typeof x !== 'number') {
      return null;
    }

    const candidate: IGeocodeCandidate = {
      formattedAddress: c.address,
      location: { lat: y, lng: x },
    };

    if (c.extent !== undefined && c.extent !== null) {
      candidate.viewport = {
        southwest: { lat: c.extent.ymin, lng: c.extent.xmin },
        northeast: { lat: c.extent.ymax, lng: c.extent.xmax },
      };
    }

    return candidate;
  }

  /**
   * Parse the response body + raise a {@link ConnectorError} for non-2xx HTTP
   * responses. Surfaces Retry-After in `providerMessage` and `cause` by design (no structured retry field).
   */
  private async raiseHttpError(
    response: Response,
    failureLabel: string,
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
      message: `${failureLabel}: ${response.status}`,
      statusCode: response.status,
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }

  /**
   * Build a {@link ConnectorError} for ESRI's 200-with-error-body case.
   */
  private raiseBodyError(
    data: { error?: { message: string; code: number } },
    status: number,
    failureLabel: string,
  ): ConnectorError {
    const err = data.error;
    const errorBody = data as unknown as Record<string, unknown>;
    return new ConnectorError({
      message: `${failureLabel}: ${err?.message ?? err?.code ?? 'unknown'}`,
      statusCode: status,
      providerCode: this.mapVendorError(status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, null),
      cause: err,
    });
  }

  /**
   * Map ESRI (HTTP status, decoded body) → canonical {@link ProviderCode}
   * Handles both HTTP-level codes and ESRI's 200-with-error-body
   * case via `body.error.code`. 16.
   */
  private mapVendorError(
    httpStatus: number,
    body: Record<string, unknown> | null,
  ): ProviderCode {
    const bodyErrorCode = readBodyErrorCode(body);

    // Precedence fix (Esri 429-precedence): `429 → rate_limited` takes
    // precedence over the body-code → 'unknown' fallthrough, so a genuinely
    // rate-limited response carrying an ambiguous in-body error code still
    // classifies correctly. The 200-with-error-body quirk is preserved: a 200
    // status won't match this check, so in-body mapping still governs there.
    if (httpStatus === 429 || bodyErrorCode === 429) return 'rate_limited';

    if (bodyErrorCode !== null) {
      if (
        bodyErrorCode === 498 ||
        bodyErrorCode === 499 ||
        bodyErrorCode === 403
      ) {
        return 'auth_failed';
      }
      if (bodyErrorCode === 400 || bodyErrorCode === 404) {
        return 'invalid_request';
      }
      if (bodyErrorCode === 500) {
        return 'provider_unavailable';
      }
      return 'unknown';
    }

    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design (no structured retry field).
   */
  private formatProviderMessage(
    body: Record<string, unknown> | null,
    retryAfter: string | null,
  ): string | null {
    const base = readEsriErrorMessage(body);

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

function stringifyQueryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function readBodyErrorCode(body: Record<string, unknown> | null): number | null {
  if (body === null) return null;
  const errorField = body.error;
  if (errorField === null || typeof errorField !== 'object') return null;
  const code = (errorField as Record<string, unknown>).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code !== '' && !Number.isNaN(Number(code))) {
    return Number(code);
  }
  return null;
}

function readEsriErrorMessage(
  body: Record<string, unknown> | null,
): string | null {
  if (body === null) return null;
  const errorField = body.error;
  if (errorField !== null && typeof errorField === 'object') {
    const errObj = errorField as Record<string, unknown>;
    const msg = errObj.message;
    if (typeof msg === 'string' && msg !== '') return msg;
    const code = errObj.code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code !== '') return code;
  }
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof errorField === 'string' && errorField !== '') return errorField;
  return null;
}
