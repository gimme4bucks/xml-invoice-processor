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
});
