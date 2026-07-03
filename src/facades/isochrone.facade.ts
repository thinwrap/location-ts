import type {
  IIsochroneConnector,
  IIsochroneOptions,
  IIsochroneResult,
  IsochroneOptionsFor,
  ProviderConfigMap,
  IsochroneProvider,
} from '../types';
import { MapboxIsochroneConnector } from '../providers/mapbox';
import { HereIsochroneConnector } from '../providers/here';
import { EsriIsochroneConnector } from '../providers/esri';
import { TomTomIsochroneConnector } from '../providers/tomtom';

// NOTE: Does **not** `implements IIsochroneConnector` — Mapbox +
// TomTom augment {@link IsochroneOptionsMap} to widen `travelMode` to include
// `'cycling'`. That augmentation makes the per-`P` input type strictly wider
// than base `IIsochroneOptions`, which is not contravariantly assignable to
// the base contract. The facade still functions as an isochrone connector at
// runtime; the contract is enforced inside each underlying per-provider
// connector class (HERE, ESRI, Mapbox, TomTom) which DO `implements
// IIsochroneConnector` at base.
export class Isochrone<P extends IsochroneProvider> {
  readonly providerId: P;
  private connector: IIsochroneConnector;

  constructor(provider: P, config: ProviderConfigMap[P], fetchImpl?: typeof fetch) {
    this.providerId = provider;
    this.connector = createIsochroneConnector(provider, config, fetchImpl);
  }

  // Per-provider input narrowing via `IsochroneOptionsMap` augmentation in
  // `src/providers/<id>/<id>.types.ts`. Mapbox + TomTom augment
  // to widen `travelMode` to include `'cycling'`; HERE + ESRI stay narrowed
  // at base `'driving' | 'walking'`.
  isochrone(options: IsochroneOptionsFor<P>): Promise<IIsochroneResult> {
    return this.connector.isochrone(options as IIsochroneOptions);
  }
}

function createIsochroneConnector<P extends IsochroneProvider>(
  provider: P,
  config: ProviderConfigMap[P],
  fetchImpl?: typeof fetch
): IIsochroneConnector {
  switch (provider) {
    case 'mapbox':
      return new MapboxIsochroneConnector(config as ProviderConfigMap['mapbox'], fetchImpl);
    case 'here':
      return new HereIsochroneConnector(config as ProviderConfigMap['here'], fetchImpl);
    case 'esri':
      return new EsriIsochroneConnector(config as ProviderConfigMap['esri'], fetchImpl);
    case 'tomtom':
      return new TomTomIsochroneConnector(config as ProviderConfigMap['tomtom'], fetchImpl);
    default:
      throw new Error(`Unknown isochrone provider: ${provider}`);
  }
}
