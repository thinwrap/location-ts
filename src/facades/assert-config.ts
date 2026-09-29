/**
 * Facade construction guard: the config must be an object.
 *
 * Unguarded, a missing config would surface only at call time, as an unrelated
 * `TypeError` ("Cannot read properties of null") from inside a connector, or,
 * on OSRM, as a `ConnectorError` that tells the caller to fix request data. A
 * missing config is a bug in the calling code, so it is a `TypeError` thrown by
 * the constructor, before any operation can run.
 *
 * @throws {TypeError} when `config` is `null`, `undefined` or not an object.
 */
export function assertConfigObject(config: unknown, facade: string): void {
  if (config === null || typeof config !== 'object') {
    const received = config === null ? 'null' : typeof config;
    throw new TypeError(`${facade} requires a config object (received ${received})`);
  }
}
