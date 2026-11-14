import type { Server } from 'node:http';
import { Controller, Get, type INestApplication, Module, Req } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configureHttpApp, type HttpAppOptions, httpAppOptions } from './http-app';

/** What Express makes of the client behind the request: the address and the scheme. */
@Controller('client')
class ClientController {
  @Get()
  client(@Req() req: Request): { ip?: string; protocol: string } {
    return { ip: req.ip, protocol: req.protocol };
  }
}

/** Stand-ins for the organisation endpoints and the support endpoints, as OpenAPI sees them. */
@ApiBearerAuth()
@Controller('documents')
class OrganisationController {
  @Get()
  list(): string[] {
    return [];
  }
}

@ApiBearerAuth()
@Controller('support/documents')
class SupportController {
  @Get()
  list(): string[] {
    return [];
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
  controllers: [ClientController, OrganisationController, SupportController],
})
class ClientModule {}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** GET /client on an app set up by configureHttpApp, with the given request headers. */
async function getClient(options: HttpAppOptions, headers: Record<string, string> = {}) {
  return get('/client', options, headers);
}

/** GET on an app set up by configureHttpApp. */
async function get(path: string, options: HttpAppOptions, headers: Record<string, string> = {}) {
  const moduleRef = await Test.createTestingModule({ imports: [ClientModule] }).compile();
  app = moduleRef.createNestApplication(httpAppOptions);
  configureHttpApp(app, options);
  await app.init();
  return request(app.getHttpServer() as Server)
    .get(path)
    .set(headers);
}

describe('configureHttpApp: the proxy in front of the API', () => {
  async function client(options: HttpAppOptions, forwardedFor: string) {
    const response = await getClient(options, {
      'X-Forwarded-For': forwardedFor,
      'X-Forwarded-Proto': 'https',
    });
    return response.body as { ip: string; protocol: string };
  }

  it('ignores X-Forwarded-For by default: a client can send anything', async () => {
    const seen = await client({}, '203.0.113.9');

    expect(seen.ip).toMatch(/127\.0\.0\.1$/);
    expect(seen.protocol).toBe('http');
  });

  it('behind the proxy, believes only the address the proxy added, not a spoofed one', async () => {
    // The client sent "X-Forwarded-For: 203.0.113.9"; the proxy appended the address it saw.
    const seen = await client({ trustProxy: true }, '203.0.113.9, 198.51.100.7');

    expect(seen.ip).toBe('198.51.100.7');
    expect(seen.protocol).toBe('https');
  });
});

describe('configureHttpApp: Strict-Transport-Security', () => {
  it('keeps browsers on HTTPS for a year by default', async () => {
    const response = await getClient({});

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('uses a shorter max-age when configured, so a local stack does not pin a browser', async () => {
    const response = await getClient({ hstsMaxAgeSeconds: 300 });

    expect(response.headers['strict-transport-security']).toBe('max-age=300; includeSubDomains');
  });
});

describe('configureHttpApp: the Swagger UI login with client credentials', () => {
  const oauthTokenUrl = 'https://idp.test/token';

  it('declares the clientCredentials flow with the configured tokenUrl and both scopes', async () => {
    const { body } = await get('/openapi.json', { oauthTokenUrl });

    expect(body.components.securitySchemes['client-credentials']).toEqual({
      type: 'oauth2',
      description: expect.any(String),
      flows: {
        clientCredentials: {
          tokenUrl: oauthTokenUrl,
          scopes: { 'documents:submit': expect.any(String), 'documents:read': expect.any(String) },
        },
      },
    });
    expect(body.components.securitySchemes.bearer).toMatchObject({ scheme: 'bearer' });
  });

  it('offers it on the organisation endpoints next to the bearer token, not on /support', async () => {
    const { body } = await get('/openapi.json', { oauthTokenUrl });

    expect(body.paths['/documents'].get.security).toEqual([
      { bearer: [] },
      { 'client-credentials': [] },
    ]);
    expect(body.paths['/support/documents'].get.security).toEqual([{ bearer: [] }]);
  });

  it('declares no OAuth2 flow without a token URL', async () => {
    const { body } = await get('/openapi.json', {});

    expect(body.components.securitySchemes['client-credentials']).toBeUndefined();
    expect(body.paths['/documents'].get.security).toEqual([{ bearer: [] }]);
  });

  it("lets the Swagger UI connect to the token URL's origin, and to nothing else", async () => {
    const withLogin = await get('/docs', { oauthTokenUrl });
    expect(withLogin.headers['content-security-policy']).toMatch(
      /(^|;)connect-src 'self' https:\/\/idp\.test(;|$)/,
    );

    const without = await get('/docs', {});
    expect(without.headers['content-security-policy']).not.toContain('idp.test');
    expect(without.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
