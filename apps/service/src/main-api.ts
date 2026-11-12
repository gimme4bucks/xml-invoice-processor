import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { adapterProviders } from './app/adapters';
import { ApiModule } from './app/modules';
import { loadConfig } from './shared/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(ApiModule.register(adapterProviders(config)));
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
