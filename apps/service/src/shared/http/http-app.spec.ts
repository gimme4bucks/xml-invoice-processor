import type { Server } from 'node:http';
import { Controller, Get, type INestApplication, Module, Req } from '@nestjs/common';
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

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
  controllers: [ClientController],
})
class ClientModule {}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** GET /client on an app set up by configureHttpApp, with the given request headers. */
async function getClient(options: HttpAppOptions, headers: Record<string, string> = {}) {
  const moduleRef = await Test.createTestingModule({ imports: [ClientModule] }).compile();
  app = moduleRef.createNestApplication(httpAppOptions);
  configureHttpApp(app, options);
  await app.init();
  return request(app.getHttpServer() as Server)
    .get('/client')
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
