import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('does not trust a proxy unless TRUST_PROXY is set', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('keeps the HSTS max-age at a year unless HSTS_MAX_AGE_SECONDS says otherwise', () => {
    expect(loadConfig({}).HSTS_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(loadConfig({ HSTS_MAX_AGE_SECONDS: '300' }).HSTS_MAX_AGE_SECONDS).toBe(300);
  });

  it('keeps CORS off unless CORS_ORIGINS lists exact origins', () => {
    expect(loadConfig({}).CORS_ORIGINS).toEqual([]);
    expect(
      loadConfig({ CORS_ORIGINS: 'https://support.test, https://localhost:5443' }).CORS_ORIGINS,
    ).toEqual(['https://support.test', 'https://localhost:5443']);
    for (const invalid of ['*', 'support.test', 'https://support.test/', 'https://a.test/path']) {
      expect(() => loadConfig({ CORS_ORIGINS: invalid }), invalid).toThrow();
    }
  });

  it('takes the token URL for the Swagger UI login from AUTH_TOKEN_URL, an absolute URL', () => {
    expect(loadConfig({}).AUTH_TOKEN_URL).toBeUndefined();
    expect(loadConfig({ AUTH_TOKEN_URL: 'https://idp.test/token' }).AUTH_TOKEN_URL).toBe(
      'https://idp.test/token',
    );
    for (const invalid of ['/token', 'idp.test/token']) {
      expect(() => loadConfig({ AUTH_TOKEN_URL: invalid }), invalid).toThrow();
    }
  });
});
