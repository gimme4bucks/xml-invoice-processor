import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config';

/** How access tokens are verified. Swapping the IdP (Cognito, Entra, Keycloak) is only config. */
export interface AuthOptions {
  issuer: string;
  audience: string;
  /** Resolves the signing key for a token header: a remote JWKS in production, local in tests. */
  keys: JWTVerifyGetKey;
}

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

/** Only ES256: no `alg: none` and no RS/HS algorithm confusion. */
export const ALLOWED_ALGORITHMS = ['ES256'];

/**
 * Builds the options from AUTH_* and fails at startup when one is missing. jose caches the JWKS
 * (10 min), refetches on an unknown `kid` (at most every 30 s) and times out after 5 s.
 */
export function remoteAuthOptions(config: AppConfig): AuthOptions {
  const { AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL } = config;
  if (!AUTH_ISSUER || !AUTH_AUDIENCE || !AUTH_JWKS_URL) {
    throw new Error('AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL are required to run the API');
  }
  return {
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE,
    keys: createRemoteJWKSet(new URL(AUTH_JWKS_URL)),
  };
}
