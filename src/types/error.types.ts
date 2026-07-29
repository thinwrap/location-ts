export type ProviderCode =
  // === 6 notifications-canonical values (shared across thinwrap scopes) ===
  | 'invalid_recipient'
  | 'rate_limited'
  | 'auth_failed'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'unknown'
  // === 7 location-extended values ===
  | 'unsupported_field' // e.g., OSRM rejecting `departureTime` → typed pre-flight error
  | 'unsupported_option' // e.g., OSRM rejecting `avoidTolls` → typed pre-flight error
  | 'unsupported_travel_mode' // e.g., TomTom/ESRI Matrix rejecting cycling → typed error
  | 'profile_not_configured' // OSRM missing compiled profile for requested travel mode
  | 'matrix_polling_timeout' // HERE/TomTom Matrix exceeded 60s deadline
  // The provider answered successfully but no route exists between the given
  // waypoints (OSRM NoRoute/NoTrips/NoSegment, Mapbox NoRoute/NoTrips, Google
  // empty `routes[]`, HERE/Esri no-solution). Distinct from `invalid_request`:
  // the request was well-formed, the world just has no connecting route — so it
  // is a business outcome to branch on, not a bug to fix. Vendors disagree
  // wildly on the HTTP status (OSRM 400, Mapbox 422, Google 200), which is
  // exactly why this needs a normalized code.
  | 'no_route'
  // The request exceeded the transport's timeout before any response arrived.
  // Separate from `provider_unavailable` because it is the one transport failure
  // a caller acts on differently: back off and retry, rather than treat the
  // provider as down.
  | 'timeout';

export class ConnectorError extends Error {
  public readonly statusCode: number | null;
  public readonly providerCode: ProviderCode;
  public readonly providerMessage: string | null;

  constructor(options: {
    message?: string;
    statusCode: number | null;
    providerCode: ProviderCode;
    providerMessage?: string | null;
    cause?: unknown;
  }) {
    super(options.message ?? options.providerMessage ?? 'Connector error', { cause: options.cause });
    this.name = 'ConnectorError';
    this.statusCode = options.statusCode;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage ?? null;
  }
}
