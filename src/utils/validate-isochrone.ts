import type { IIsochroneOptions } from '../types';
import { ConnectorError } from '../types';

/**
 * Maximum number of contour breaks supported across all 4 Isochrone
 * providers, set by Mapbox's native ceiling.
 */
export const MAX_ISOCHRONE_VALUES = 4;

/**
 * Shared validator for the cross-provider 4-value cap.
 *
 * Invoked at the top of every per-connector `.isochrone()` implementation
 * before any wire work. Throws a `ConnectorError`
 * with `providerCode: 'invalid_request'` when `options.values.length` exceeds
 * the {@link MAX_ISOCHRONE_VALUES} ceiling.
 *
 * This is a deliberate small exception to the "no shared middleware"
 * rule: cross-cutting
 * validation that ALL providers share belongs in a shared helper, but
 * per-vendor variance stays in the connector.
 *
 * @param options Caller-supplied isochrone options.
 * @throws {ConnectorError} when `options.values.length > MAX_ISOCHRONE_VALUES`.
 */
export function validateIsochroneCap(options: Pick<IIsochroneOptions, 'values'>): void {
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
