import { BaseConnector, isErrorBodyUnavailable } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { isRecord, malformedResponseError, mergePassthrough } from '../../utils';
import { assertNonEmptyMatrix, validateMatrixOptions } from '../../utils/validate-options';
import { assertFiniteCoordinate } from '../../utils/coordinate';
import { isTrafficRequested } from '../../utils/traffic';
import type { GoogleConfig } from './google.config';
import { GOOGLE_MATRIX_FIELD_MASK } from './google.defaults';
import type { GoogleRouteMatrixElement } from './google.types';
import { mapGoogleReason, readGoogleErrorReason } from './google.error-reason';

const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/**
 * Google Distance Matrix v2 (RouteMatrix) connector.
 *
 * POSTs to https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix
 * with `X-Goog-Api-Key` and `X-Goog-FieldMask` headers. Google emits an
 * NDJSON-ish stream (one JSON object per origin/destination pair, concatenated
 * by newlines, not array-wrapped). The connector reads the full body, splits
 * on newlines, parses each line, and accumulates into a flat `cells[]`.
 * Failed cells (non-zero `status.code`) are retained in
 * `result.raw` but omitted from `cells[]`. No retry, no caching.
 */
export class GoogleMatrixConnector
  extends BaseConnector
  implements IMatrixConnector
{
  readonly providerId = 'google';

  constructor(private config: GoogleConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl);
  }

  async matrix(options: IMatrixOptions): Promise<IMatrixResult> {
    validateMatrixOptions(options, 'Google Matrix');
    assertNonEmptyMatrix(options, 'Google Matrix');
    // Reject NaN/non-finite coordinates before they serialize into the JSON
    // body (JSON.stringify(NaN) === "null" would silently corrupt the request).
    // Out-of-range but finite lat/lng pass through verbatim (thin-wrapper).
    for (const coord of [...options.origins, ...options.destinations]) {
      assertFiniteCoordinate(coord, 'Google Matrix');
    }

    const origins = options.origins.map((o) => ({
      waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
    }));

    const destinations = options.destinations.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    }));

    const travelMode = this.mapTravelMode(options.travelMode);
    const body: Record<string, unknown> = {
      origins,
      destinations,
      travelMode,
    };

    // Google rejects `routingPreference` for WALK/BICYCLE ("Routing preference
    // cannot be set for WALK or BICYCLE routing mode.") — only DRIVE and
    // TWO_WHEELER accept it. Overridable via `_passthrough.body`.
    //
    // `TRAFFIC_AWARE` is a Pro-tier SKU feature, and Route Matrix bills PER
    // ELEMENT — so it follows the explicit `trafficMode` opt-in rather than the
    // presence of `departureTime`. Deriving it from a departure time would move
    // origins x destinations billed elements onto Pro pricing at once.
    const traffic = isTrafficRequested(options.trafficMode);
    if (travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER') {
      body.routingPreference = traffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE';
    }

    if (options.avoidTolls) {
      body.routeModifiers = { avoidTolls: true };
    }

    // The departure time is sent only with traffic. Google answers HTTP 400
    // "Timestamp cannot be set for TRAFFIC_UNAWARE routing mode." when both are
    // present, and documents that an unaware matrix is computed on
    // time-independent speeds, so under `'none'` the time could change nothing.
    if (options.departureTime && traffic) {
      body.departureTime = options.departureTime.toISOString();
    }

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask': GOOGLE_MATRIX_FIELD_MASK.join(','),
    };

    const merged = mergePassthrough(body, headers, options._passthrough);

    const response = await this.sendPostJson(MATRIX_URL, merged.body, {
      headers: merged.headers,
      query: merged.query,
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const retryAfter = response.headers.get('retry-after');
      const cause =
        retryAfter !== null
          ? { ...(errorBody ?? {}), retryAfter }
          : errorBody;
      throw new ConnectorError({
        message: `Google Matrix failed: ${response.status}`,
        statusCode: response.status,
        providerCode: this.mapVendorError(response.status, errorBody),
        providerMessage: this.formatProviderMessage(errorBody, retryAfter),
        cause,
      });
    }

    // Google RouteMatrix v2 streams NDJSON: one JSON object per element,
    // concatenated by newlines (not array-wrapped). Read the full body and
    // split + parse each non-empty line.
    const text = await response.text();
    const elements = parseNdjsonElements(text, response.status);

    // Every requested pair gets an element, failed ones included, so an empty
    // answer to a non-empty request is not "no cells" — it is a body we cannot
    // read. Reporting it as an empty success would fabricate a result.
    if (
      elements.length === 0 &&
      options.origins.length > 0 &&
      options.destinations.length > 0
    ) {
      throw malformedResponseError('Google Matrix', 'no elements', response.status, text);
    }

    const cells: IMatrixCell[] = [];
    for (const el of elements) {
      if (!isRecord(el)) {
        throw malformedResponseError('Google Matrix', 'an element is not an object', response.status, elements);
      }
      if (!isSuccessfulElement(el)) continue;
      if (!Number.isInteger(el.originIndex) || !Number.isInteger(el.destinationIndex)) {
        throw malformedResponseError(
          'Google Matrix',
          'an element has no originIndex/destinationIndex',
          response.status,
          elements,
        );
      }
      cells.push({
        originIndex: el.originIndex,
        destinationIndex: el.destinationIndex,
        // Google's JSON omits zero-valued fields (a same-point pair), so an
        // absent distance/duration on a ROUTE_EXISTS element is 0 by definition.
        distanceMeters: el.distanceMeters ?? 0,
        durationSeconds: parseDuration(el.duration ?? '0s'),
      });
    }

    return { cells, raw: elements };
  }

  /**
   * Map (HTTP status, decoded body) → canonical {@link ProviderCode}. Lives on the
   * connector rather than in `BaseConnector`: error translation is per-provider.
   */
  private mapVendorError(httpStatus: number, body: unknown): ProviderCode {
    // Prefer the structured google.rpc.ErrorInfo reason (robust) over the HTTP
    // status: Google returns 400 INVALID_ARGUMENT for an invalid key, which the
    // status-only mapping below would misread as invalid_request.
    const reasonCode = mapGoogleReason(readGoogleErrorReason(body));
    if (reasonCode !== null) return reasonCode;

    const googleStatus = readGoogleErrorStatus(body);

    // Google answers HTTP 400 for BOTH an invalid key and a malformed request —
    // only `error.details[].reason` separates them, and the headers are
    // byte-identical (verified live). So when the body never reached us, the
    // status-only fallback below cannot justify `invalid_request`: say `unknown`
    // rather than confidently blame the caller's request.
    if (isErrorBodyUnavailable(body)) return 'unknown';

    if (httpStatus === 401) return 'auth_failed';
    if (httpStatus === 403) {
      if (googleStatus === 'QUOTA_EXCEEDED') return 'rate_limited';
      return 'auth_failed';
    }
    if (httpStatus === 429) return 'rate_limited';
    if (httpStatus === 400) return 'invalid_request';
    if (httpStatus >= 500 && httpStatus < 600) return 'provider_unavailable';

    return 'unknown';
  }

  /**
   * Build the human-readable `providerMessage` from the vendor body, weaving
   * in parsed Retry-After seconds when present. No structured
   * `retryAfterSeconds` field on `ConnectorError`
   * by design.
   */
  private formatProviderMessage(
    body: unknown,
    retryAfter: string | null,
  ): string | null {
    const base = readGoogleErrorMessage(body);

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
        return 'WALK';
      case 'cycling':
        return 'BICYCLE';
      default:
        return 'DRIVE';
    }
  }
}

/** Parse Google duration string "123s" → number of seconds. */
function parseDuration(duration: string): number {
  return parseInt(duration.replace('s', ''), 10) || 0;
}

/**
 * Parse Google RouteMatrix v2's NDJSON-like body. Each line is a JSON object
 * for one (originIndex, destinationIndex) pair; the body is NOT array-wrapped.
 * Tolerates both pure NDJSON and the occasional array-wrapped envelope.
 */
function parseNdjsonElements(text: string, statusCode: number): GoogleRouteMatrixElement[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  // Defensive: some Google responses (or mocks) may wrap elements in a JSON
  // array. Detect and short-circuit before splitting on newlines.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr as GoogleRouteMatrixElement[];
    } catch {
      // fall through to NDJSON parsing
    }
  }

  const elements: GoogleRouteMatrixElement[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      elements.push(JSON.parse(line) as GoogleRouteMatrixElement);
    } catch (cause) {
      // A single malformed/keep-alive/diagnostic line must not escape as a raw
      // SyntaxError and discard the whole successful response. Normalize to the
      // unified ConnectorError contract.
      throw new ConnectorError({
        message: 'Google Matrix returned an unparseable NDJSON line',
        statusCode,
        // No 'invalid_response' ProviderCode exists in error.types.ts; 'unknown'
        // is the closest existing value for a malformed provider body.
        providerCode: 'unknown',
        providerMessage: 'Google Matrix returned an unparseable NDJSON line',
        cause,
      });
    }
  }
  return elements;
}

/**
 * Whether an element is a usable cell. Failed cells are retained in `raw` but
 * excluded from `cells[]`.
 *
 * `status` is a `google.rpc.Status` whose OK form Google serializes as `{}` or
 * omits (proto3 drops default values), so an absent/empty status or code 0 is
 * OK. `condition` is independent of it: an element can be status-OK with
 * `ROUTE_NOT_FOUND`, so anything other than `ROUTE_EXISTS` is a failed cell.
 *
 * An element carrying NEITHER field says nothing about whether a route exists
 * — `condition` is in the connector's field mask and `ROUTE_EXISTS` is not a
 * default value Google would drop — so it is treated as failed rather than
 * read as a 0 m / 0 s cell.
 */
function isSuccessfulElement(el: GoogleRouteMatrixElement): boolean {
  const status = el.status;
  if (el.condition === undefined && (status === undefined || status === null)) {
    return false;
  }
  const statusOk =
    status === undefined ||
    status === null ||
    status.code === undefined ||
    status.code === null ||
    status.code === 0;
  if (!statusOk) return false;
  if (el.condition !== undefined && el.condition !== 'ROUTE_EXISTS') {
    return false;
  }
  return true;
}

function readGoogleErrorStatus(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object' && 'status' in err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'string') return status;
    }
  }
  return null;
}

function readGoogleErrorMessage(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg !== '') return msg;
    }
  }
  return null;
}
