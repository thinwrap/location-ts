import { BaseConnector } from '../../base/base.connector';
import type {
  IMatrixCell,
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
} from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types/error.types';
import { mergePassthrough } from '../../utils';
import type { GoogleConfig } from './google.config';
import type { GoogleRouteMatrixElement } from './google.types';

const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/**
 * Google Distance Matrix v2 (RouteMatrix) connector — per-connector template
 *
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
    const origins = options.origins.map((o) => ({
      waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
    }));

    const destinations = options.destinations.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    }));

    const body: Record<string, unknown> = {
      origins,
      destinations,
      travelMode: this.mapTravelMode(options.travelMode),
      // TRAFFIC_AWARE when a departureTime is supplied (the consumer cares about
      // timing), else TRAFFIC_UNAWARE; overridable via `_passthrough.body`.
      // NOTE (loc-CR #119, 2026-05-29): flagged as a sub-baseline knob, but this
      // is a defensible internal default backed by tests — left
      // intact pending a product decision rather than dropped silently.
      routingPreference: options.departureTime
        ? 'TRAFFIC_AWARE'
        : 'TRAFFIC_UNAWARE',
    };

    if (options.avoidTolls) {
      body.routeModifiers = { avoidTolls: true };
    }

    if (options.departureTime) {
      body.departureTime = options.departureTime.toISOString();
    }

    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask':
        'originIndex,destinationIndex,distanceMeters,duration,status',
    };

    const merged = mergePassthrough(body, headers, options._passthrough);

    const response = await this.sendPostJson(MATRIX_URL, merged.body, {
      headers: merged.headers,
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
    const elements = parseNdjsonElements(text);

    const cells: IMatrixCell[] = elements
      .filter(isSuccessfulElement)
      .map((el) => ({
        originIndex: el.originIndex,
        destinationIndex: el.destinationIndex,
        distanceMeters: el.distanceMeters ?? 0,
        durationSeconds: parseDuration(el.duration ?? '0s'),
      }));

    return { cells, raw: elements };
  }

  /**
   * Map (HTTP status, decoded body) → canonical {@link ProviderCode}. Per
   * (per-connector locality).    */
  private mapVendorError(httpStatus: number, body: unknown): ProviderCode {
    // Prefer the structured google.rpc.ErrorInfo reason (robust) over the HTTP
    // status: Google returns 400 INVALID_ARGUMENT for an invalid key, which the
    // status-only mapping below would misread as invalid_request.
    const reasonCode = mapGoogleReason(readGoogleErrorReason(body));
    if (reasonCode !== null) return reasonCode;

    const googleStatus = readGoogleErrorStatus(body);

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
function parseNdjsonElements(text: string): GoogleRouteMatrixElement[] {
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
        statusCode: null,
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
 * An element is "successful" when its `status` field is absent (Google omits
 * it on success when the field mask requests it) OR its `status.code` is 0
 * (the RPC OK code). Per, failed cells are retained in `raw` but excluded
 * from `cells[]`.
 */
function isSuccessfulElement(el: GoogleRouteMatrixElement): boolean {
  const status = el.status;
  if (status === undefined || status === null) return true;
  const code = status.code;
  if (code === undefined || code === null) return true;
  return code === 0;
}

/**
 * Read the machine-readable reason from a `google.rpc.ErrorInfo` entry in
 * `error.details[]` (domain `googleapis.com`). This is a stable enum from
 * `google/api/error_reason.proto`, unlike the human `message`.
 */
function readGoogleErrorReason(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || !('error' in body)) return null;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== 'object' || !('details' in err)) return null;
  const details = (err as { details?: unknown }).details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (d === null || typeof d !== 'object') continue;
    const domain = (d as { domain?: unknown }).domain;
    const type = (d as { '@type'?: unknown })['@type'];
    const isErrorInfo =
      domain === 'googleapis.com' ||
      (typeof type === 'string' && type.endsWith('google.rpc.ErrorInfo'));
    if (!isErrorInfo) continue;
    const reason = (d as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  return null;
}

const GOOGLE_AUTH_REASONS = new Set<string>([
  'API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED',
  'CREDENTIALS_MISSING', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'ACCOUNT_STATE_INVALID', 'CONSUMER_INVALID',
  'CONSUMER_SUSPENDED', 'USER_PROJECT_DENIED', 'SERVICE_DISABLED', 'BILLING_DISABLED',
]);
const GOOGLE_RATE_REASONS = new Set<string>(['RATE_LIMIT_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED']);

/**
 * Map a `google.rpc.ErrorInfo` reason to a canonical {@link ProviderCode}, or
 * `null` to fall back to the HTTP-status mapping.
 */
function mapGoogleReason(reason: string | null): ProviderCode | null {
  if (reason === null) return null;
  if (GOOGLE_AUTH_REASONS.has(reason)) return 'auth_failed';
  if (GOOGLE_RATE_REASONS.has(reason)) return 'rate_limited';
  return null;
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
