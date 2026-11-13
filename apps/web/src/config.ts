/**
 * Where the support app finds the API and the IdP, and who it is at the IdP. Read at runtime from
 * /config.js, which the image's static server writes from its environment (ADR 0018), so one
 * image serves every environment. The static server builds its CSP's connect-src from the same
 * values.
 */
export interface AppConfig {
  /** The API's base URL; the support endpoints are below it. */
  apiUrl: string;
  /** The IdP's issuer: `/authorize` and `/token` are below it, and `iss` must equal it. */
  issuer: string;
  /** The public client registered at the IdP (no secret). */
  clientId: string;
}

/** The configuration is missing or wrong: the app cannot sign anybody in. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Where the static server serves the configuration: an ES module, so the CSP's script-src applies. */
export const CONFIG_URL = '/config.js';

/** Loads and checks /config.js. */
export async function loadConfig(): Promise<AppConfig> {
  const module = (await import(/* @vite-ignore */ CONFIG_URL)) as { default?: unknown };
  return parseConfig(module.default);
}

export function parseConfig(value: unknown): AppConfig {
  const config = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const clientId = config.clientId;
  if (typeof clientId !== 'string' || clientId === '') {
    throw new ConfigError('The configuration has no clientId.');
  }
  return {
    apiUrl: httpsUrl(config.apiUrl, 'apiUrl'),
    issuer: httpsUrl(config.issuer, 'issuer'),
    clientId,
  };
}

/** Only HTTPS: the token and the code must never travel in clear text. */
function httpsUrl(value: unknown, name: string): string {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== 'https:') {
    throw new ConfigError(`The configuration's ${name} must be an https:// URL.`);
  }
  return url.href.replace(/\/+$/, '');
}
