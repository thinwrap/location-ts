import type {
  IMatrixConnector,
  IMatrixOptions,
  IMatrixResult,
  MatrixOptionsFor,
  MatrixProvider,
  ProviderConfigMap,
} from '../types';
import { GoogleMatrixConnector } from '../providers/google';
import { MapboxMatrixConnector } from '../providers/mapbox';
import { HereMatrixConnector } from '../providers/here';
import { EsriMatrixConnector } from '../providers/esri';
import { OsrmMatrixConnector } from '../providers/osrm';
import { TomTomMatrixConnector } from '../providers/tomtom';
import { assertConfigObject } from './assert-config';

export class Matrix<P extends MatrixProvider> implements IMatrixConnector {
  readonly providerId: P;
  private connector: IMatrixConnector;

  /**
   * @throws {TypeError} synchronously, for an unknown provider (or one without
   *   a matrix connector) or a missing config: misuse of the API, deliberately
   *   not a `ConnectorError`.
   */
  constructor(provider: P, config: ProviderConfigMap[P], fetchImpl?: typeof fetch) {
    this.providerId = provider;
    this.connector = createMatrixConnector(provider, config, fetchImpl);
  }

  // Per-provider input narrowing via `MatrixOptionsMap` augmentation in
  // `src/providers/<id>/<id>.types.ts`. At v1.0 with no augmentations,
  // `MatrixOptionsFor<P>` resolves to `IMatrixOptions` for every provider.
  matrix(options: MatrixOptionsFor<P>): Promise<IMatrixResult> {
    return this.connector.matrix(options as IMatrixOptions);
  }
}

function createMatrixConnector<P extends MatrixProvider>(
  provider: P,
  config: ProviderConfigMap[P],
  fetchImpl?: typeof fetch
): IMatrixConnector {
  assertConfigObject(config, 'Matrix');
  switch (provider) {
    case 'google':
      return new GoogleMatrixConnector(config as ProviderConfigMap['google'], fetchImpl);
    case 'mapbox':
      return new MapboxMatrixConnector(config as ProviderConfigMap['mapbox'], fetchImpl);
    case 'here':
      return new HereMatrixConnector(config as ProviderConfigMap['here'], fetchImpl);
    case 'esri':
      return new EsriMatrixConnector(config as ProviderConfigMap['esri'], fetchImpl);
    case 'osrm':
      return new OsrmMatrixConnector(config as ProviderConfigMap['osrm'], fetchImpl);
    case 'tomtom':
      return new TomTomMatrixConnector(config as ProviderConfigMap['tomtom'], fetchImpl);
    default:
      throw new TypeError(`Unknown matrix provider: ${String(provider)}`);
  }
}
