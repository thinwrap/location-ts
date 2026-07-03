import { describe, it, expect } from 'vitest';
import { ConnectorError, type ProviderCode } from './error.types';

const ALL_PROVIDER_CODES: ProviderCode[] = [
  'invalid_recipient',
  'rate_limited',
  'auth_failed',
  'provider_unavailable',
  'invalid_request',
  'unknown',
  'unsupported_field',
  'unsupported_option',
  'unsupported_travel_mode',
  'profile_not_configured',
  'matrix_polling_timeout',
];

describe('ConnectorError', () => {
  it('accepts each of the 11 ProviderCode values', () => {
    for (const code of ALL_PROVIDER_CODES) {
      const err = new ConnectorError({ statusCode: 400, providerCode: code });
      expect(err.providerCode).toBe(code);
    }
  });

  it('preserves statusCode:null', () => {
    const err = new ConnectorError({ statusCode: null, providerCode: 'provider_unavailable' });
    expect(err.statusCode).toBeNull();
  });

  it('preserves statusCode:429', () => {
    const err = new ConnectorError({ statusCode: 429, providerCode: 'rate_limited' });
    expect(err.statusCode).toBe(429);
  });

  it('round-trips cause as unknown payload', () => {
    const causePayload = { foo: 'bar', nested: { code: 42 } };
    const err = new ConnectorError({ statusCode: 500, providerCode: 'unknown', cause: causePayload });
    expect(err.cause).toEqual(causePayload);
  });

  it('preserves providerMessage when provided', () => {
    const err = new ConnectorError({
      statusCode: 400,
      providerCode: 'invalid_request',
      providerMessage: 'vendor said no',
    });
    expect(err.providerMessage).toBe('vendor said no');
  });

  it('returns providerMessage as null when not provided (no undefined)', () => {
    const err = new ConnectorError({ statusCode: 500, providerCode: 'provider_unavailable' });
    expect(err.providerMessage).toBeNull();
  });

  it('falls back message: explicit message wins, then providerMessage, then default', () => {
    const a = new ConnectorError({ statusCode: 400, providerCode: 'invalid_request', message: 'explicit' });
    expect(a.message).toBe('explicit');

    const b = new ConnectorError({ statusCode: 400, providerCode: 'invalid_request', providerMessage: 'pm' });
    expect(b.message).toBe('pm');

    const c = new ConnectorError({ statusCode: 400, providerCode: 'invalid_request' });
    expect(c.message).toBe('Connector error');
  });

  it('sets name to "ConnectorError"', () => {
    const err = new ConnectorError({ statusCode: 400, providerCode: 'unknown' });
    expect(err.name).toBe('ConnectorError');
  });

  it('is an instance of Error', () => {
    const err = new ConnectorError({ statusCode: 400, providerCode: 'unknown' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
  });
});
