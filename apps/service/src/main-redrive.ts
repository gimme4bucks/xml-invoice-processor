import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { destination } from 'pino';
import { redriveProviders } from './app/adapters';
import { RedriveModule } from './app/modules';
import {
  DlqRedrive,
  parseRedriveArgs,
  redriveExitCode,
  redriveSummary,
} from './documents/adapters/inbound/messaging/dlq-redrive';
import { loadConfig } from './shared/config';

/**
 * `xip redrive [--dry-run] [--limit N]` (ADR 0014): sends the documents of dead-lettered messages
 * back to the workers through the outbox. Prints a JSON summary (counts and IDs) on stdout; the
 * JSON log lines go to stderr. Exit code 0: nothing left behind (or a dry run); 1: messages stayed
 * in the DLQ and need attention or another run; 2: usage, configuration or connection error.
 */
async function main(): Promise<number> {
  const options = parseRedriveArgs(process.argv.slice(2));
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(
    RedriveModule.register(redriveProviders(config), {
      logging: { level: config.LOG_LEVEL, destination: destination({ dest: 2, sync: true }) },
    }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(PinoLogger));
  try {
    const report = await app.get(DlqRedrive).run(options);
    process.stdout.write(`${JSON.stringify(redriveSummary(report), null, 2)}\n`);
    return redriveExitCode(report);
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`xip redrive failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
