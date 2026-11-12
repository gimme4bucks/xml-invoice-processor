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
    ApiModule.register(adapterProviders(config), {
      auth: remoteAuthOptions(config),
      rateLimit: { limit: config.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
      logging: { level: config.LOG_LEVEL },
    }),
    httpAppOptions,
  );
  configureHttpApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
