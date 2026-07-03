import { ConnectorError } from '../../types';

/**
 * Configuration for the ESRI (ArcGIS) connectors.
 *
 * **Dual-auth invariant:** ESRI Routing and adjacent ArcGIS REST
 * services accept either a long-lived API key (issued via the ArcGIS
 * Developer dashboard) or a short-lived OAuth token (obtained via the
 * ArcGIS OAuth endpoint, typically valid ~120 minutes). On the wire both
 * are forwarded via the same `token=` query/form parameter — they are
 * equivalent bearer credentials. They MUST be supplied mutually exclusively:
 * provide exactly one of {@link apiKey} or {@link arcgisToken}.
 *
 * Token refresh is consumer-owned and stateless from the connector's
 * perspective (the wrapper holds no state). Consumers
 * wanting refresh-on-401 should wrap the `fetchImpl` parameter; a future
 * `tokenCache` hook may formalize this.
 *
 * Mirrors PHP `EsriConfig::bearerToken()`.
 */
export interface EsriConfig {
  /** Long-lived ArcGIS Developer API key. Mutually exclusive with {@link arcgisToken}. */
  apiKey?: string;
  /** Short-lived ArcGIS OAuth token (~120 min default lifetime). Mutually exclusive with {@link apiKey}. */
  arcgisToken?: string;
}

/**
 * Resolve the bearer credential to forward on the `token=` parameter,
 * enforcing the {@link EsriConfig} dual-auth XOR invariant. Throws a
 * {@link ConnectorError} with `providerCode: 'invalid_request'` when both or
 * neither are set.
 */
export function resolveEsriBearerToken(config: EsriConfig): string {
  const hasApiKey = typeof config.apiKey === 'string' && config.apiKey !== '';
  const hasArcgisToken =
    typeof config.arcgisToken === 'string' && config.arcgisToken !== '';

  if (hasApiKey && hasArcgisToken) {
    throw new ConnectorError({
      message:
        'EsriConfig: apiKey and arcgisToken are mutually exclusive — provide exactly one.',
      statusCode: null,
      providerCode: 'invalid_request',
      providerMessage:
        'EsriConfig: apiKey and arcgisToken are mutually exclusive — provide exactly one.',
    });
  }

  if (!hasApiKey && !hasArcgisToken) {
    throw new ConnectorError({
      message:
        'EsriConfig: one of apiKey or arcgisToken is required.',
      statusCode: null,
      providerCode: 'auth_failed',
      providerMessage:
        'EsriConfig: one of apiKey or arcgisToken is required.',
    });
  }

  return (hasApiKey ? config.apiKey : config.arcgisToken) as string;
}
