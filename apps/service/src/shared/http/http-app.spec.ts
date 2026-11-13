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

describe('configureHttpApp: the proxy in front of the API', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function client(options: HttpAppOptions, forwardedFor: string) {
    const moduleRef = await Test.createTestingModule({ imports: [ClientModule] }).compile();
    app = moduleRef.createNestApplication(httpAppOptions);
    configureHttpApp(app, options);
    await app.init();
    const response = await request(app.getHttpServer() as Server)
      .get('/client')
      .set('X-Forwarded-For', forwardedFor)
      .set('X-Forwarded-Proto', 'https');
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
