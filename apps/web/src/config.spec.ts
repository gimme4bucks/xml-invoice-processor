import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const valid = {
  apiUrl: 'https://localhost:3443',
  issuer: 'https://localhost:4443',
  clientId: 'support-web',
};

describe('runtime configuration (/config.js)', () => {
  it('reads the API URL, the issuer and the client id', () => {
    expect(parseConfig(valid)).toEqual(valid);
  });

  it('drops a trailing slash, so paths can be appended', () => {
    const config = parseConfig({
      ...valid,
      apiUrl: 'https://api.test/',
      issuer: 'https://idp.test/',
    });

    expect(config.apiUrl).toBe('https://api.test');
    expect(config.issuer).toBe('https://idp.test');
  });

  it.each([
    ['nothing', undefined],
    ['no client id', { ...valid, clientId: '' }],
    ['an API URL that is not a URL', { ...valid, apiUrl: 'localhost:3443' }],
    [
      'a plain HTTP API, which would send the token in clear text',
      { ...valid, apiUrl: 'http://api.test' },
    ],
    [
      'a plain HTTP issuer, which would send the code in clear text',
      { ...valid, issuer: 'http://idp.test' },
    ],
  ])('refuses %s', (_case, value) => {
    expect(() => parseConfig(value)).toThrow(/configuration/i);
  });
});
