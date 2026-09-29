import type {
  IMatrixOptions,
  IPlaceDetailsOptions,
  IRoutingOptions,
} from '../types';
import { ConnectorError } from '../types';
import {
  assertOneOf,
  assertTokens,
  PLACE_DETAILS_INCLUDE_TOKENS,
  POLYLINE_QUALITIES,
  ROUTING_INCLUDE_TOKENS,
  TRAFFIC_MODES,
  TRAVEL_MODES,
} from './assert-one-of';
import { assertValidDate } from './datetime';

/*
 * Entry checks shared by every connector of an operation, called first thing
 * in the operation method so the outcome never depends on which provider was
 * picked. Misuse (a value outside a closed vocabulary, a wrong type) is a
 * `TypeError`; bad request data (an invalid `Date`) is a `ConnectorError`.
 */

/**
 * @param context Names the connector for error messages (`'Google Routing'`).
 * @throws {TypeError} for an unknown `travelMode`, `trafficMode`,
 *   `polylineQuality` or `include` token, or a `departureTime` that is not a `Date`.
 * @throws {ConnectorError} `invalid_request` for an invalid `Date`.
 */
export function validateRoutingOptions(options: IRoutingOptions, context: string): void {
  assertOneOf(options.travelMode, TRAVEL_MODES, 'travelMode');
  assertOneOf(options.trafficMode, TRAFFIC_MODES, 'trafficMode');
  assertOneOf(options.polylineQuality, POLYLINE_QUALITIES, 'polylineQuality');
  assertTokens(options.include, ROUTING_INCLUDE_TOKENS, 'include');
  if (options.departureTime !== undefined) assertValidDate(options.departureTime, context);
}

/**
 * @param context Names the connector for error messages (`'Google Matrix'`).
 * @throws {TypeError} for an unknown `travelMode` or `trafficMode`, or a
 *   `departureTime` that is not a `Date`.
 * @throws {ConnectorError} `invalid_request` for an invalid `Date`.
 */
export function validateMatrixOptions(options: IMatrixOptions, context: string): void {
  assertOneOf(options.travelMode, TRAVEL_MODES, 'travelMode');
  assertOneOf(options.trafficMode, TRAFFIC_MODES, 'trafficMode');
  if (options.departureTime !== undefined) assertValidDate(options.departureTime, context);
}

/**
 * An empty `origins` or `destinations` list is a request no provider can
 * answer, so it is bad request data (`invalid_request`), refused before the
 * round-trip (on HERE and TomTom, before an async submit). Esri, Mapbox and
 * OSRM make the same check with their own messages.
 *
 * @throws {ConnectorError} `invalid_request` when either list is empty.
 */
export function assertNonEmptyMatrix(options: IMatrixOptions, context: string): void {
  if (options.origins.length === 0 || options.destinations.length === 0) {
    const message = `${context} requires at least one origin and one destination`;
    throw new ConnectorError({
      message,
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage: message,
    });
  }
}

/** @throws {TypeError} for an unknown `include` token. */
export function validatePlaceDetailsOptions(options: IPlaceDetailsOptions): void {
  assertTokens(options.include, PLACE_DETAILS_INCLUDE_TOKENS, 'include');
}
