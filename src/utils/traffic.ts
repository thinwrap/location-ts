import type { TrafficMode } from '../types/routing.interface';

/**
 * Whether the caller asked for traffic-aware durations.
 *
 * The single place that knows `'live'` is an alias of `'traffic'`: every
 * connector decides traffic through this helper, so the alias can never drift
 * into meaning something different on one provider. Unset means `'none'`.
 */
export function isTrafficRequested(mode: TrafficMode | undefined): boolean {
  return mode === 'traffic' || mode === 'live';
}
