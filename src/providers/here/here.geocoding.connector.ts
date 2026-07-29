import { BaseConnector } from '../../base/base.connector';
import type {
  IGeocodingConnector,
  IGeocodeOptions,
  IGeocodeResult,
  IReverseGeocodeOptions,
  IReverseGeocodeResult,
  IAutocompleteOptions,
  IAutocompletePrediction,
  IPlaceDetailsOptions,
  IPlaceDetailsResult,
  IAutocompleteResult,
  IGeocodeCandidate,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import { assertFiniteCoordinate, formatCoord } from '../../utils/coordinate';
import type { HereConfig } from './here.config';
import type {
  HereGeocodeResponse,
  HereAutocompleteResponse,
  HereGeocodeItem,
} from './here.types';

const GEOCODE_URL = 'https://geocode.search.hereapi.com/v1/geocode';
const REVGEOCODE_URL = 'https://revgeocode.search.hereapi.com/v1/revgeocode';
const AUTOSUGGEST_URL = 'https://autosuggest.search.hereapi.com/v1/autosuggest';
const LOOKUP_URL = 'https://lookup.search.hereapi.com/v1/lookup';

/**
 * Complete ISO 3166-1 alpha-2 → alpha-3 country code translation.
 *
 * HERE Geocoding v7 expects alpha-3 codes in `in=countryCode:` whereas the
 * base {@link IGeocodeOptions.countryFilter} is alpha-2. This map lives
 * per-connector (no shared utility).
 *
 * Covers all current ISO 3166-1 alpha-2 codes. Unmapped (non-ISO) codes raise
 * `ConnectorError providerCode:'invalid_request'` and direct consumers to
 * `_passthrough.query.in` for any code HERE accepts that is not standard ISO.
 */
const ISO_ALPHA2_TO_ALPHA3: Record<string, string> = {
  AD: 'AND', AE: 'ARE', AF: 'AFG', AG: 'ATG', AI: 'AIA', AL: 'ALB', AM: 'ARM',
  AO: 'AGO', AQ: 'ATA', AR: 'ARG', AS: 'ASM', AT: 'AUT', AU: 'AUS', AW: 'ABW',
  AX: 'ALA', AZ: 'AZE', BA: 'BIH', BB: 'BRB', BD: 'BGD', BE: 'BEL', BF: 'BFA',
  BG: 'BGR', BH: 'BHR', BI: 'BDI', BJ: 'BEN', BL: 'BLM', BM: 'BMU', BN: 'BRN',
  BO: 'BOL', BQ: 'BES', BR: 'BRA', BS: 'BHS', BT: 'BTN', BV: 'BVT', BW: 'BWA',
  BY: 'BLR', BZ: 'BLZ', CA: 'CAN', CC: 'CCK', CD: 'COD', CF: 'CAF', CG: 'COG',
  CH: 'CHE', CI: 'CIV', CK: 'COK', CL: 'CHL', CM: 'CMR', CN: 'CHN', CO: 'COL',
  CR: 'CRI', CU: 'CUB', CV: 'CPV', CW: 'CUW', CX: 'CXR', CY: 'CYP', CZ: 'CZE',
  DE: 'DEU', DJ: 'DJI', DK: 'DNK', DM: 'DMA', DO: 'DOM', DZ: 'DZA', EC: 'ECU',
  EE: 'EST', EG: 'EGY', EH: 'ESH', ER: 'ERI', ES: 'ESP', ET: 'ETH', FI: 'FIN',
  FJ: 'FJI', FK: 'FLK', FM: 'FSM', FO: 'FRO', FR: 'FRA', GA: 'GAB', GB: 'GBR',
  GD: 'GRD', GE: 'GEO', GF: 'GUF', GG: 'GGY', GH: 'GHA', GI: 'GIB', GL: 'GRL',
  GM: 'GMB', GN: 'GIN', GP: 'GLP', GQ: 'GNQ', GR: 'GRC', GS: 'SGS', GT: 'GTM',
  GU: 'GUM', GW: 'GNB', GY: 'GUY', HK: 'HKG', HM: 'HMD', HN: 'HND', HR: 'HRV',
  HT: 'HTI', HU: 'HUN', ID: 'IDN', IE: 'IRL', IL: 'ISR', IM: 'IMN', IN: 'IND',
  IO: 'IOT', IQ: 'IRQ', IR: 'IRN', IS: 'ISL', IT: 'ITA', JE: 'JEY', JM: 'JAM',
  JO: 'JOR', JP: 'JPN', KE: 'KEN', KG: 'KGZ', KH: 'KHM', KI: 'KIR', KM: 'COM',
  KN: 'KNA', KP: 'PRK', KR: 'KOR', KW: 'KWT', KY: 'CYM', KZ: 'KAZ', LA: 'LAO',
  LB: 'LBN', LC: 'LCA', LI: 'LIE', LK: 'LKA', LR: 'LBR', LS: 'LSO', LT: 'LTU',
  LU: 'LUX', LV: 'LVA', LY: 'LBY', MA: 'MAR', MC: 'MCO', MD: 'MDA', ME: 'MNE',
  MF: 'MAF', MG: 'MDG', MH: 'MHL', MK: 'MKD', ML: 'MLI', MM: 'MMR', MN: 'MNG',
  MO: 'MAC', MP: 'MNP', MQ: 'MTQ', MR: 'MRT', MS: 'MSR', MT: 'MLT', MU: 'MUS',
  MV: 'MDV', MW: 'MWI', MX: 'MEX', MY: 'MYS', MZ: 'MOZ', NA: 'NAM', NC: 'NCL',
  NE: 'NER', NF: 'NFK', NG: 'NGA', NI: 'NIC', NL: 'NLD', NO: 'NOR', NP: 'NPL',
  NR: 'NRU', NU: 'NIU', NZ: 'NZL', OM: 'OMN', PA: 'PAN', PE: 'PER', PF: 'PYF',
  PG: 'PNG', PH: 'PHL', PK: 'PAK', PL: 'POL', PM: 'SPM', PN: 'PCN', PR: 'PRI',
  PS: 'PSE', PT: 'PRT', PW: 'PLW', PY: 'PRY', QA: 'QAT', RE: 'REU', RO: 'ROU',
  RS: 'SRB', RU: 'RUS', RW: 'RWA', SA: 'SAU', SB: 'SLB', SC: 'SYC', SD: 'SDN',
  SE: 'SWE', SG: 'SGP', SH: 'SHN', SI: 'SVN', SJ: 'SJM', SK: 'SVK', SL: 'SLE',
  SM: 'SMR', SN: 'SEN', SO: 'SOM', SR: 'SUR', SS: 'SSD', ST: 'STP', SV: 'SLV',
  SX: 'SXM', SY: 'SYR', SZ: 'SWZ', TC: 'TCA', TD: 'TCD', TF: 'ATF', TG: 'TGO',
  TH: 'THA', TJ: 'TJK', TK: 'TKL', TL: 'TLS', TM: 'TKM', TN: 'TUN', TO: 'TON',
  TR: 'TUR', TT: 'TTO', TV: 'TUV', TW: 'TWN', TZ: 'TZA', UA: 'UKR', UG: 'UGA',
  UM: 'UMI', US: 'USA', UY: 'URY', UZ: 'UZB', VA: 'VAT', VC: 'VCT', VE: 'VEN',
  VG: 'VGB', VI: 'VIR', VN: 'VNM', VU: 'VUT', WF: 'WLF', WS: 'WSM', YE: 'YEM',
  YT: 'MYT', ZA: 'ZAF', ZM: 'ZMB', ZW: 'ZWE',
};

/**
 * HERE Geocoding v7 connector.
 *
 * Three endpoints, three dispatch shapes:
 *
 *   - `GET https://geocode.search.hereapi.com/v1/geocode` for forward geocode.
 *   - `GET https://revgeocode.search.hereapi.com/v1/revgeocode` for reverse.
 *   - `GET https://autosuggest.search.hereapi.com/v1/autosuggest` for
 *     autocomplete with optional proximity bias via `in=circle:...`.
 *
 * The per-connector ISO alpha-2 → alpha-3 translation lives inline
 * (no shared utility). Retry-After is surfaced as parsed seconds in
 * `providerMessage` plus the raw header in `cause.retryAfter`.
 */
export class HereGeocodingConnector
  extends BaseConnector
  implements IGeocodingConnector
{
  readonly providerId = 'here';

  constructor(private config: HereConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  /**
   * `countryFilter` (alpha-2) → HERE's `in=countryCode:<alpha-3 CSV>` value.
   *
   * Shared by `geocode` and `autocomplete` so the two cannot drift on which
   * codes they accept. Returns `undefined` when there is nothing to filter on,
   * which keeps "no country filter" distinguishable from "an empty one".
   */
  private toCountryCodeFilter(
    countryFilter: string[] | undefined,
  ): string | undefined {
    if (countryFilter === undefined || countryFilter.length === 0) {
      return undefined;
    }

    const alpha3: string[] = [];
    for (const code of countryFilter) {
      // Skip empty/whitespace-only entries gracefully rather than emitting a
      // confusing "mapping unavailable for " error.
      if (typeof code !== 'string' || code.trim() === '') continue;
      const mapped = ISO_ALPHA2_TO_ALPHA3[code.toUpperCase()];
      if (mapped === undefined) {
        throw new ConnectorError({
          message: `HERE country code mapping unavailable for ${code}; please use _passthrough.query.in to pass HERE's alpha-3 directly.`,
          statusCode: null,
          providerCode: 'invalid_request',
          providerMessage: `HERE country code mapping unavailable for ${code}; please use _passthrough.query.in to pass HERE's alpha-3 directly.`,
        });
      }
      alpha3.push(mapped);
    }

    return alpha3.length > 0 ? `countryCode:${alpha3.join(',')}` : undefined;
  }

  async geocode(options: IGeocodeOptions): Promise<IGeocodeResult> {
    const baseQuery: Record<string, string> = {
      q: options.address,
      apiKey: this.config.apiKey,
    };

    if (options.language) baseQuery.lang = options.language;

    const countryCodeFilter = this.toCountryCodeFilter(options.countryFilter);
    if (countryCodeFilter !== undefined) {
      baseQuery.in = countryCodeFilter;
    }

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(GEOCODE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Geocoding');
    }

    const data = (await response.json().catch(() => null)) as
      | HereGeocodeResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Geocoding returned an unparseable response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Geocoding returned an unparseable response body',
      });
    }
    return {
      candidates: (data.items ?? [])
        .map((item) => normalizeCandidate(item))
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async reverseGeocode(
    options: IReverseGeocodeOptions,
  ): Promise<IReverseGeocodeResult> {
    // Fail fast on NaN/non-finite coordinates before a network round-trip.
    // Out-of-range lat/lng passes through verbatim (thin-wrapper philosophy).
    assertFiniteCoordinate(options.location, 'HERE reverseGeocode');

    const baseQuery: Record<string, string> = {
      at: `${formatCoord(options.location.lat)},${formatCoord(options.location.lng)}`,
      apiKey: this.config.apiKey,
    };

    if (options.language) baseQuery.lang = options.language;

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    const response = await this.sendGet(REVGEOCODE_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Reverse Geocoding');
    }

    const data = (await response.json().catch(() => null)) as
      | HereGeocodeResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Reverse Geocoding returned an unparseable response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage:
          'HERE Reverse Geocoding returned an unparseable response body',
      });
    }
    // reverse-geocode mirrors forward shape — return all candidates,
    // not just the first result.
    return {
      candidates: (data.items ?? [])
        .map((item) => normalizeCandidate(item))
        .filter((c): c is IGeocodeCandidate => c !== null),
      raw: data,
    };
  }

  async autocomplete(
    options: IAutocompleteOptions,
  ): Promise<IAutocompleteResult> {
    const baseQuery: Record<string, string> = {
      q: options.input,
      apiKey: this.config.apiKey,
      limit: '10',
    };

    if (options.language) baseQuery.lang = options.language;

    // HERE supports `in=circle:<lat>,<lng>;r=<radius>` for proximity
    // bias when both `location` and `radius` are set. With only `location`,
    // fall back to `at=` for proximity.
    if (options.location !== undefined) {
      assertFiniteCoordinate(options.location, 'HERE autocomplete location');
      if (options.radius !== undefined) {
        baseQuery.in = `circle:${formatCoord(options.location.lat)},${formatCoord(options.location.lng)};r=${options.radius}`;
      } else {
        baseQuery.at = `${formatCoord(options.location.lat)},${formatCoord(options.location.lng)}`;
      }
    }

    const countryCodeFilter = this.toCountryCodeFilter(options.countryFilter);

    const merged = mergePassthrough(
      {} as Record<string, unknown>,
      {},
      options._passthrough,
      baseQuery,
    );

    // Autosuggest is the one HERE endpoint that mandates a search context:
    // exactly one of `at`, `in=circle` or `in=bbox`, and a country filter has to
    // accompany one of them. Without it HERE rejects the request, so fail here
    // with something actionable instead of relaying a vendor 400. Checked after
    // the merge so a consumer supplying their own `in=bbox:` still satisfies it.
    if (!merged.query.at && !merged.query.in) {
      const message =
        'HERE Autosuggest requires a search context: pass `location` (optionally with `radius`), or supply one via _passthrough.query.at / _passthrough.query.in.';
      throw new ConnectorError({
        message,
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: message,
      });
    }

    // The country filter rides ALONGSIDE the spatial context rather than
    // replacing it, and HERE spells both as `in`. URLSearchParams keeps the pair
    // via .append (NOT .set), the same way repeated `via` works on routing.
    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(merged.query)) {
      urlParams.append(key, val);
    }
    if (countryCodeFilter !== undefined) {
      urlParams.append('in', countryCodeFilter);
    }

    const response = await this.sendGet(
      `${AUTOSUGGEST_URL}?${urlParams.toString()}`,
      { headers: merged.headers },
    );

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Autosuggest');
    }

    const data = (await response.json().catch(() => null)) as
      | HereAutocompleteResponse
      | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Autosuggest returned an unparseable response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage:
          'HERE Autosuggest returned an unparseable response body',
      });
    }
    return {
      predictions: (data.items ?? []).map((item) => {
        const prediction: IAutocompletePrediction = {
          description: item.title,
          placeId: item.id,
        };
        // HERE's *query*-type suggestions carry a title but no address at all, so
        // `secondaryText` is omitted rather than emitted as an empty string a UI
        // would render as a blank second line.
        if (typeof item.title === 'string' && item.title !== '') {
          const label = item.address?.label;
          prediction.structuredFormat = {
            mainText: item.title,
            ...(typeof label === 'string' && label !== ''
              ? { secondaryText: label }
              : {}),
          };
        }
        return prediction;
      }),
      raw: data,
    };
  }

  /**
   * Map HERE (HTTP status, body) → canonical {@link ProviderCode}.
   * the mapping lives per-connector (no shared middleware).
   */
  private mapVendorError(
    httpStatus: number,
    _body: Record<string, unknown> | null,
  ): ProviderCode {
    if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';
    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present by design.
   */
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
   * Parse the response body + raise a {@link ConnectorError} for non-2xx. The
   * cause object merges in Retry-After when present by design (no structured retry field).
   */
  /**
   * Resolve a HERE place id to a full candidate.
   *
   * `GET https://lookup.search.hereapi.com/v1/lookup?id=` — the same normalizer as
   * geocode, since HERE returns one `items[]`-shaped entry.
   */
  async placeDetails(options: IPlaceDetailsOptions): Promise<IPlaceDetailsResult> {
    const query: Record<string, string> = {
      apiKey: this.config.apiKey,
      id: options.placeId,
    };
    if (options.language !== undefined) {
      query.lang = options.language;
    }

    const merged = mergePassthrough({}, {}, options._passthrough, query);
    const response = await this.sendGet(LOOKUP_URL, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      throw await this.raiseHttpError(response, 'HERE Place Details');
    }

    const data = (await response.json().catch(() => null)) as HereGeocodeItem | null;
    if (data === null) {
      throw new ConnectorError({
        message: 'HERE Place Details returned a malformed response body',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'HERE Place Details returned a malformed response body',
        cause: data,
      });
    }

    const candidate = normalizeCandidate(data);
    if (candidate === null) {
      throw new ConnectorError({
        message: 'HERE Place Details returned no position',
        statusCode: response.status,
        providerCode: 'no_route',
        providerMessage: 'HERE Place Details returned no position',
        cause: data,
      });
    }

    const wantsName = options.include?.includes('name') === true;
    return {
      candidate,
      // HERE's `title` is the display name; free, but still gated so the shape
      // matches every other provider.
      ...(wantsName && typeof data.title === 'string' && data.title !== ''
        ? { name: data.title }
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
      providerCode: this.mapVendorError(response.status, errorBody),
      providerMessage: this.formatProviderMessage(errorBody, retryAfter),
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single HERE `items[]` entry to {@link IGeocodeCandidate}.
 *
 * - `formattedAddress` ← `title` (or `address.label` fallback).
 * - `location` ← `position.{lat,lng}`.
 * - `placeId` ← `id` (HERE's locationId).
 * - `viewport` ← derived from `mapView` (south/west/north/east) when present.
 */
/**
 * Normalize one HERE `items[]` entry.
 *
 * Returns `null` (the caller skips the row) when `position.lat`/`lng` are absent
 * or non-numeric — never fabricate a Null-Island (0,0) candidate, and never let a
 * missing node surface as a raw `TypeError` outside the `ConnectorError`
 * contract. Same rule as the other four geocoding connectors.
 */
function normalizeCandidate(item: HereGeocodeItem): IGeocodeCandidate | null {
  const lat = item.position?.lat;
  const lng = item.position?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const formattedAddress =
    typeof item.title === 'string' && item.title !== ''
      ? item.title
      : (item.address?.label ?? '');

  const candidate: IGeocodeCandidate = {
    formattedAddress,
    location: { lat, lng },
  };

  if (typeof item.id === 'string' && item.id !== '') {
    candidate.placeId = item.id;
  }

  const mapView = item.mapView;
  if (
    mapView !== undefined &&
    typeof mapView.south === 'number' &&
    typeof mapView.west === 'number' &&
    typeof mapView.north === 'number' &&
    typeof mapView.east === 'number'
  ) {
    candidate.viewport = {
      southwest: { lat: mapView.south, lng: mapView.west },
      northeast: { lat: mapView.north, lng: mapView.east },
    };
  }

  return candidate;
}

function readHereErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  // HERE v8 errors: { title, cause, status }.
  const title = obj.title;
  const cause = obj.cause;
  if (typeof title === 'string' && title !== '') {
    if (typeof cause === 'string' && cause !== '') {
      return `${title}: ${cause}`;
    }
    return title;
  }
  if (typeof cause === 'string' && cause !== '') return cause;

  // Fallback: nested { error: { message } } or top-level { message } / { error }.
  const error = obj.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  if (typeof obj.message === 'string' && obj.message !== '') return obj.message;
  if (typeof error === 'string' && error !== '') return error;

  return null;
}
