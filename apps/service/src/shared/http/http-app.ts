import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { setupOpenApi } from './openapi';
import { SUPPORT_PATH, supportCors } from './support-cors';

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
  /**
   * How long browsers keep to HTTPS for this host (Strict-Transport-Security), a year by default.
   * The compose stack sends a short one: browsers that apply HSTS to `localhost` would otherwise
   * force every http://localhost port to HTTPS for a year.
   */
  hstsMaxAgeSeconds?: number;
  /**
   * Browser origins of the support app (CORS_ORIGINS, exact matches). Empty, the default, keeps
   * CORS off; set, it opens only the read-only support endpoints (ADR 0017).
   */
  corsOrigins?: readonly string[];
  /**
   * The IdP's token endpoint (AUTH_TOKEN_URL). Set, the Swagger UI offers a client-credentials
   * login, and its CSP lets the page call that endpoint's origin (ADR 0019).
   */
  oauthTokenUrl?: string;
}

/** Everything the API needs on top of ApiModule; shared by main-api.ts and the HTTP tests. */
export function configureHttpApp(app: INestApplication, options: HttpAppOptions = {}): void {
  // One hop, not `true`: with `true`, Express would believe the first address, the client's own.
  if (options.trustProxy) (app as NestExpressApplication).set('trust proxy', 1);
  app.useLogger(app.get(Logger));
  // Security headers, including Strict-Transport-Security. upgrade-insecure-requests is dropped
  // so Swagger UI also works over plain http on localhost during development; in compose, TLS is
  // terminated by the edge in front of the service. With a token URL, the Swagger UI may also
  // connect to the IdP's origin, and to no other.
  const tokenOrigin = options.oauthTokenUrl && new URL(options.oauthTokenUrl).origin;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          upgradeInsecureRequests: null,
          ...(tokenOrigin ? { connectSrc: ["'self'", tokenOrigin] } : {}),
        },
      },
      strictTransportSecurity: {
        maxAge: options.hstsMaxAgeSeconds ?? 31_536_000,
        includeSubDomains: true,
      },
    }),
  );
  // No enableCors: the organisations' clients are servers, not browsers. Only the support app
  // runs in a browser, so only its endpoints get CORS, and only for the listed origins.
  if (options.corsOrigins?.length) app.use(SUPPORT_PATH, supportCors(options.corsOrigins));
  setupOpenApi(app, { oauthTokenUrl: options.oauthTokenUrl });
}
