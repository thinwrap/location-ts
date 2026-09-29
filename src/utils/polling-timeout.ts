import type { Passthrough } from '../types/passthrough.type';
import { ConnectorError } from '../types/error.types';

/**
 * The async-matrix polling deadline from `_passthrough.body.timeoutMs`, or
 * `undefined` when the caller did not set one.
 *
 * Only a finite number of milliseconds greater than zero is accepted. Anything
 * else — a numeric string, NaN/Infinity, zero or a negative — is refused before
 * any request: coercing it or falling back to the default would apply a
 * deadline the caller did not ask for.
 */
export function readPollingTimeoutMs(
  passthrough: Passthrough | undefined,
  provider: string,
): number | undefined {
  const value = passthrough?.body?.timeoutMs;
  // An explicit `undefined` is "not set", as it is for every other deep-merged
  // body key.
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  const message = `${provider}: _passthrough.body.timeoutMs must be a finite number of milliseconds greater than 0`;
  throw new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}
