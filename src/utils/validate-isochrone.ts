import type { IIsochroneOptions } from '../types';
import { ConnectorError } from '../types';
import { assertOneOf, ISOCHRONE_TYPES, TRAVEL_MODES } from './assert-one-of';

/**
 * Maximum number of contour breaks supported across all 4 Isochrone
 * providers, set by Mapbox's native ceiling.
 */
export const MAX_ISOCHRONE_VALUES = 4;

/**
 * Shared entry validator for every per-connector `.isochrone()`, including the
 * cross-provider 4-value cap.
 *
 * Invoked at the top of every per-connector `.isochrone()` implementation
 * before any wire work.
 *
 * This is a deliberate small exception to the "no shared middleware"
 * rule: cross-cutting
 * validation that ALL providers share belongs in a shared helper, but
 * per-vendor variance stays in the connector.
 *
 * @param options Caller-supplied isochrone options.
 * @throws {TypeError} when `type` is missing or not `'time'`/`'distance'`,
 *   `travelMode` is not `'driving'`/`'walking'`/`'cycling'`, or `departureTime`
 *   is not a string — misuse of the API, deliberately not a `ConnectorError`.
 * @throws {ConnectorError} `providerCode: 'invalid_request'` when
 *   `departureTime` does not parse, or `values` is empty, holds a non-positive
 *   or non-finite break, or is longer than {@link MAX_ISOCHRONE_VALUES}.
 */
export function validateIsochroneCap(
  options: Pick<IIsochroneOptions, 'values'> &
    Partial<Pick<IIsochroneOptions, 'type' | 'departureTime' | 'travelMode'>>,
): void {
  // Checked at runtime because a JS caller (or an `as` cast) can pass anything:
  // every connector branches `type === 'time'` / else, so an empty or unknown
  // value would silently be sent as a distance isochrone. The vocabulary is the
  // library's API, not request data, so a value outside it is a `TypeError`.
  // `travelMode` accepts the union of every provider's isochrone modes:
  // `'cycling'` is a real mode that some providers lack, which the connector
  // reports as `unsupported_travel_mode`.
  if (options.type === undefined) {
    throw new TypeError("isochrone type is required (expected one of 'time', 'distance')");
  }
  assertOneOf(options.type, ISOCHRONE_TYPES, 'isochrone type');
  assertOneOf(options.travelMode, TRAVEL_MODES, 'travelMode');
  if (options.departureTime !== undefined && typeof options.departureTime !== 'string') {
    throw new TypeError(
      `isochrone departureTime must be an ISO 8601 string (received ${typeof options.departureTime})`,
    );
  }
  // Every provider takes the ISO 8601 string as-is, and none rejects garbage
  // loudly enough to trust: an unparseable time is refused here instead.
  if (
    options.departureTime !== undefined &&
    options.departureTime !== '' &&
    !Number.isFinite(Date.parse(options.departureTime))
  ) {
    const message = 'isochrone departureTime is not a valid ISO 8601 date/time';
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: message,
    });
  }
  if (options.values.length < 1) {
    throw new ConnectorError({
      message: 'isochrone requires at least one break value',
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: 'isochrone requires at least one break value',
    });
  }
  for (const value of options.values) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConnectorError({
        message: 'isochrone break values must be finite numbers greater than 0',
        statusCode: null,
        providerCode: 'invalid_request',
        providerMessage: 'isochrone break values must be finite numbers greater than 0',
      });
    }
  }
  if (options.values.length > MAX_ISOCHRONE_VALUES) {
    throw new ConnectorError({
      message: `Maximum ${MAX_ISOCHRONE_VALUES} values supported (Mapbox native ceiling)`,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: `Maximum ${MAX_ISOCHRONE_VALUES} values supported (Mapbox native ceiling)`,
    });
  }
}
