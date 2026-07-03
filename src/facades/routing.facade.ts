import type {
  IRoutingConnector,
  IRoutingOptions,
  IRoutingResult,
  ProviderConfigMap,
  RoutingOptionsFor,
  RoutingProvider,
} from '../types';
import { GoogleRoutingConnector } from '../providers/google';
import { MapboxRoutingConnector } from '../providers/mapbox';
import { HereRoutingConnector } from '../providers/here';
import { EsriRoutingConnector } from '../providers/esri';
import { OsrmRoutingConnector } from '../providers/osrm';
import { TomTomRoutingConnector } from '../providers/tomtom';

export class Routing<P extends RoutingProvider> implements IRoutingConnector {
  readonly providerId: P;
  private connector: IRoutingConnector;

  constructor(provider: P, config: ProviderConfigMap[P], fetchImpl?: typeof fetch) {
    this.providerId = provider;
    this.connector = createRoutingConnector(provider, config, fetchImpl);
  }

  // Per-provider input narrowing via `RoutingOptionsMap` augmentation in
  // `src/providers/<id>/<id>.types.ts`. At v1.0 with no augmentations,
  // `RoutingOptionsFor<P>` resolves to `IRoutingOptions` for every provider.
  route(options: RoutingOptionsFor<P>): Promise<IRoutingResult> {
    return this.connector.route(options as IRoutingOptions);
  }
}

function createRoutingConnector<P extends RoutingProvider>(
  provider: P,
  config: ProviderConfigMap[P],
  fetchImpl?: typeof fetch
): IRoutingConnector {
  switch (provider) {
    case 'google':
      return new GoogleRoutingConnector(config as ProviderConfigMap['google'], fetchImpl);
    case 'mapbox':
      return new MapboxRoutingConnector(config as ProviderConfigMap['mapbox'], fetchImpl);
    case 'here':
      return new HereRoutingConnector(config as ProviderConfigMap['here'], fetchImpl);
    case 'esri':
      return new EsriRoutingConnector(config as ProviderConfigMap['esri'], fetchImpl);
    case 'osrm':
      return new OsrmRoutingConnector(config as ProviderConfigMap['osrm'], fetchImpl);
    case 'tomtom':
      return new TomTomRoutingConnector(config as ProviderConfigMap['tomtom'], fetchImpl);
    default:
      throw new Error(`Unknown routing provider: ${provider}`);
  }
}
