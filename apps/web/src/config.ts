/** Where the support app finds the API and the IdP, and who it is at the IdP. */
export interface AppConfig {
  apiUrl: string;
  issuer: string;
  clientId: string;
}

export function parseConfig(_value: unknown): AppConfig {
  throw new Error('Not implemented');
}
