import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createInMemoryAdapters, inMemoryProviders } from '../../../src/app/adapters';
import { ApiModule, type ApiOptions } from '../../../src/app/modules';
import type { AuthOptions } from '../../../src/shared/auth/auth-options';
import {
  configureHttpApp,
  type HttpAppOptions,
  httpAppOptions,
} from '../../../src/shared/http/http-app';

/**
 * Tokens for the HTTP tests, signed against a local JWKS (no IdP needed): organisation tokens as
 * the client-credentials grant issues them, and support tokens as the PKCE flow does (ADR 0017).
 */
export const ISSUER = 'https://idp.test';
export const AUDIENCE = 'xml-invoice-processor';

/** Supplier (0106:11111111) and customer (0106:22222222) of the invoice fixtures. */
export const supplier = { org_id: 'org-supplier', peppol_id: '0106:11111111' };
export const customer = { org_id: 'org-customer', peppol_id: '0106:22222222' };

export interface TestTokens {
  auth: AuthOptions;
  /** A client-credentials token of an organisation. */
  organisation(org?: typeof supplier, scope?: string): Promise<string>;
  /** A support employee's token: `sub` and scope, no `org_id`. */
  support(sub?: string, scope?: string): Promise<string>;
  /** A validly signed token with exactly these claims (plus iss, aud, sub, iat, exp). */
  signed(claims: Record<string, string>, sub?: string): Promise<string>;
}

export async function testTokens(): Promise<TestTokens> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' };
  const sign = (claims: Record<string, string>, subject: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return {
    auth: { issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) },
    organisation: (org = supplier, scope = 'documents:submit documents:read') =>
      sign({ ...org, scope }, `${org.org_id}-client`),
    support: (sub = 'support-alice', scope = 'support:read') => sign({ scope }, sub),
    signed: (claims, sub = 'odd-subject') => sign(claims, sub),
  };
}

/** ApiModule with the in-memory adapters and the real guards, filter, logger and OpenAPI. */
export async function startTestApi(
  auth: AuthOptions,
  options: Omit<ApiOptions, 'auth'> = {},
  http: HttpAppOptions = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ApiModule.register(inMemoryProviders(createInMemoryAdapters()), {
        auth,
        logging: { level: 'silent' },
        ...options,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication(httpAppOptions);
  configureHttpApp(app, http);
  await app.listen(0, '127.0.0.1');
  return app;
}

export const httpServer = (app: INestApplication) => app.getHttpServer() as Server;
