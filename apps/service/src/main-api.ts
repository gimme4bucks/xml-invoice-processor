import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { adapterProviders } from './app/adapters';
import { ApiModule } from './app/modules';
import { remoteAuthOptions } from './shared/auth/auth-options';
import { loadConfig } from './shared/config';
import { configureHttpApp, httpAppOptions } from './shared/http/http-app';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(
    ApiModule.register(adapterProviders(config, 'api'), {
      auth: remoteAuthOptions(config),
      rateLimit: { limit: config.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
      logging: { level: config.LOG_LEVEL },
    }),
    httpAppOptions,
  );
  configureHttpApp(app, {
    trustProxy: config.TRUST_PROXY,
    hstsMaxAgeSeconds: config.HSTS_MAX_AGE_SECONDS,
    corsOrigins: config.CORS_ORIGINS,
  });
  // SIGTERM: stop accepting connections, finish the running requests, then disconnect Postgres.
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

// A configuration error (e.g. DATABASE_URL missing) stops the process before it serves anything.
bootstrap().catch((error: unknown) => {
  console.error(`API failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
