import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { adapterProviders } from './app/adapters';
import { WorkerModule } from './app/modules';
import { loadConfig } from './shared/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(adapterProviders(config)),
  );
  app.enableShutdownHooks();
}

void bootstrap();
