import { ConnectorError } from '../../types';

/**
 * Epoch milliseconds for an ESRI `startTime` / `timeOfDay` form value.
 *
 * Routing and Matrix carry `departureTime` as a `Date`, Isochrone as an ISO 8601
 * string; both land on the wire as epoch milliseconds. An invalid `Date` or an
 * unparseable string would otherwise serialize as `"NaN"`, which ESRI does not
 * reject loudly — so it fails here as `invalid_request` before any request.
 *
 * Callers pair the value with `startTimeIsUTC` / `timeOfDayIsUTC = true`: both
 * default to `false`, which makes ESRI read the instant in the time zone of the
 * first stop / facility, shifting every departure by that zone's UTC offset.
 */
export function esriEpochMillis(value: Date | string, op: string): string {
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(ms)) {
    const message = `ESRI ${op}: departureTime is not a valid date/time`;
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: message,
    });
  }
  return String(ms);
}
