import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import type { Application } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { setupOpenApi } from './openapi';

/**
 * No global body parser: the only body we accept (XML on POST /documents) is read by its
 * controller after authentication, with the size limit enforced while streaming.
 */
export const httpAppOptions: NestApplicationOptions = { bodyParser: false, bufferLogs: true };

export interface HttpAppOptions {
  /**
   * The API runs behind exactly one reverse proxy that terminates TLS (ADR 0013). Express then
   * takes the client address and scheme from the last X-Forwarded-For and X-Forwarded-Proto
   * entries, the ones that proxy added; anything a client put in front of them is ignored. Off,
   * the headers are ignored entirely, because anyone can send them.
   */
  trustProxy?: boolean;
}

/** Everything the API needs on top of ApiModule; shared by main-api.ts and the HTTP tests. */
export function configureHttpApp(app: INestApplication, options: HttpAppOptions = {}): void {
  if (options.trustProxy) app.getHttpAdapter().getInstance<Application>().set('trust proxy', 1);
  app.useLogger(app.get(Logger));
  // Security headers, including Strict-Transport-Security. upgrade-insecure-requests is dropped
  // so Swagger UI also works over plain http on localhost during development; in compose, TLS is
  // terminated by the edge in front of the service.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  // CORS stays off (no enableCors): our clients are servers, not browsers.
  setupOpenApi(app);
}
