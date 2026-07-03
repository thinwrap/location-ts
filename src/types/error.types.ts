export type ProviderCode =
  // === 6 notifications-canonical values (shared across thinwrap scopes) ===
  | 'invalid_recipient'
  | 'rate_limited'
  | 'auth_failed'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'unknown'
  // === 5 location-extended values ===
  | 'unsupported_field' // e.g., OSRM rejecting `departureTime` → typed pre-flight error
  | 'unsupported_option' // e.g., OSRM rejecting `avoidTolls` → typed pre-flight error
  | 'unsupported_travel_mode' // e.g., TomTom/ESRI Matrix rejecting cycling → typed error
  | 'profile_not_configured' // OSRM missing compiled profile for requested travel mode
  | 'matrix_polling_timeout'; // HERE/TomTom Matrix exceeded 60s deadline

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
