import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { setupOpenApi } from './openapi';

/**
 * No global body parser: the only body we accept (XML on POST /documents) is read by its
 * controller after authentication, with the size limit enforced while streaming.
 */
export const httpAppOptions: NestApplicationOptions = { bodyParser: false, bufferLogs: true };

/** Everything the API needs on top of ApiModule; shared by main-api.ts and the HTTP tests. */
export function configureHttpApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  // Security headers. upgrade-insecure-requests is dropped so Swagger UI works over plain
  // http on localhost; TLS is terminated in front of the service.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  // CORS stays off (no enableCors): our clients are servers, not browsers.
  setupOpenApi(app);
}
