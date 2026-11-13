import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { adapterProviders, consumerProviders } from './app/adapters';
import { WorkerModule } from './app/modules';
import { loadConfig } from './shared/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(adapterProviders(config, 'worker'), consumerProviders(config), {
      logging: { level: config.LOG_LEVEL },
    }),
    { bufferLogs: true },
  );
  // JSON lines through pino, with the API's redaction rules (shared/logging).
  app.useLogger(app.get(PinoLogger));
  // SIGTERM: cancel the consumer, let running messages commit and ack, stop the relay, then
  // close RabbitMQ and Postgres. A message cut off anyway is redelivered (ADR 0004).
  app.enableShutdownHooks();
  Logger.log(`Worker started (ADAPTERS=${config.ADAPTERS})`, 'Worker');
}

// A configuration error (e.g. AMQP_URL missing) stops the process before it consumes anything.
bootstrap().catch((error: unknown) => {
  console.error(
    `Worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
