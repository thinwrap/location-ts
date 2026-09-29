import { ConnectorError } from '../../types';
import type { OsrmConfig, OsrmExcludeClass } from './osrm.config';

/**
 * The normalized avoid-flag → OSRM `exclude` class mapping. Ordered, so the
 * first unsupported flag is the one reported.
 */
const OSRM_AVOID_FLAGS: ReadonlyArray<
  ['avoidTolls' | 'avoidFerries' | 'avoidHighways', OsrmExcludeClass]
> = [
  ['avoidTolls', 'toll'],
  ['avoidFerries', 'ferry'],
  ['avoidHighways', 'motorway'],
];

/**
 * The `exclude` classes for the avoid flags the caller set, shared by `/route`,
 * `/trip` and `/table` (all three take OSRM's general `exclude` option).
 *
 * Whether an avoid-flag works depends on the OPERATOR'S build, not on OSRM:
 * `exclude=toll` is rejected as `InvalidValue` by the public demo build and
 * honoured by a self-hosted instance with the class compiled in. So the
 * capability is declared in config, and a flag whose class is not declared is
 * rejected up front with `unsupported_option` rather than sent and bounced with
 * an opaque error.
 */
export function resolveOsrmExcludes(
  options: Partial<Record<'avoidTolls' | 'avoidFerries' | 'avoidHighways', boolean>>,
  config: OsrmConfig | undefined,
): OsrmExcludeClass[] {
  const supported = config?.supportedExcludeClasses ?? [];
  const excludes: OsrmExcludeClass[] = [];
  for (const [flag, excludeClass] of OSRM_AVOID_FLAGS) {
    if (options[flag] !== true) continue;
    if (!supported.includes(excludeClass)) {
      throw new ConnectorError({
        message: `OSRM does not support ${flag}`,
        statusCode: null,
        providerCode: 'unsupported_option',
        providerMessage: `${flag} requires an OSRM build with the '${excludeClass}' exclude class compiled in; declare it via OsrmConfig.supportedExcludeClasses`,
      });
    }
    excludes.push(excludeClass);
  }
  return excludes;
}
