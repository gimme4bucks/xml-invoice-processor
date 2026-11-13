import { parseArgs } from 'node:util';
import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  RequeueDocumentCommand,
  type RequeueResult,
} from '../../../application/commands/requeue-document';
import type { DocumentStatus } from '../../../domain/value-objects';

/** One message taken from the dead-letter queue. Settle it exactly once. */
export interface DeadLetter {
  messageId: string;
  /** The parsed JSON body; undefined when the body is not JSON. */
  payload: unknown;
  /** Removes the message from the DLQ. */
  ack(): void;
  /** Puts the message back in the DLQ. */
  release(): void;
}

/** Where dead letters come from: RabbitMQ's DLQ in production, a list in tests. */
export abstract class DeadLetterSource {
  /** Messages in the queue, not counting the ones taken and not yet settled. */
  abstract count(): Promise<number>;
  /** The next message, or undefined when none is left. A taken message is not handed out again until it is released. */
  abstract next(): Promise<DeadLetter | undefined>;
}

export interface RedriveOptions {
  /** List what would happen; change nothing. */
  dryRun: boolean;
  /** At most this many messages. */
  limit?: number;
}

/** IDs only: never message content. In a dry run, `requeued` lists what would be requeued. */
export interface RedriveReport {
  dryRun: boolean;
  requeued: Array<{ documentId: string; status: DocumentStatus; attempt: number }>;
  /** Acked: the document needs nothing more. */
  alreadyFinal: Array<{ documentId: string; status: DocumentStatus }>;
  /** Left in the DLQ: no such document in this database. */
  notFound: string[];
  /** Left in the DLQ: the requeue failed (e.g. the database is down); run again later. */
  failed: string[];
  /** Left in the DLQ: message ids of messages without a document id. */
  malformed: string[];
}

/** Messages the run left in the DLQ that need attention (a dry run leaves everything, by design). */
export function leftInDlq(report: RedriveReport): number {
  return report.notFound.length + report.failed.length + report.malformed.length;
}

const USAGE = 'Usage: xip redrive [--dry-run] [--limit N]';

export function parseRedriveArgs(args: string[]): RedriveOptions {
  try {
    const { values } = parseArgs({
      args,
      options: { 'dry-run': { type: 'boolean' }, limit: { type: 'string' } },
      strict: true,
    });
    const options: RedriveOptions = { dryRun: values['dry-run'] ?? false };
    if (values.limit !== undefined) {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be at least 1');
      options.limit = limit;
    }
    return options;
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${USAGE}`);
  }
}

/**
 * `xip redrive` (ADR 0014): sends the documents of dead-lettered `process` messages to the worker
 * again. Each message becomes a RequeueDocumentCommand, which writes the new message to the
 * outbox (only the relay publishes). A message is acked only after that unit of work committed;
 * everything else is released back into the DLQ at the end of the run, so it is never lost and
 * never taken twice in one run. A run handles at most the messages that were in the DLQ when it
 * started, so a document that is dead-lettered again meanwhile waits for the next run.
 */
@Injectable()
export class DlqRedrive {
  constructor(
    private readonly source: DeadLetterSource,
    private readonly commands: CommandBus,
  ) {}

  async run(options: RedriveOptions): Promise<RedriveReport> {
    const report: RedriveReport = {
      dryRun: options.dryRun,
      requeued: [],
      alreadyFinal: [],
      notFound: [],
      failed: [],
      malformed: [],
    };
    const limit = Math.min(options.limit ?? Infinity, await this.source.count());
    const keep: DeadLetter[] = [];
    try {
      for (let handled = 0; handled < limit; handled++) {
        const letter = await this.source.next();
        if (!letter) break;
        if (this.handled(await this.redrive(letter, options.dryRun, report), options.dryRun)) {
          letter.ack();
        } else {
          keep.push(letter);
        }
      }
    } finally {
      for (const letter of keep) letter.release();
    }
    return report;
  }

  /** Records the outcome in the report and returns it; undefined for a message that stays. */
  private async redrive(
    letter: DeadLetter,
    dryRun: boolean,
    report: RedriveReport,
  ): Promise<RequeueResult | undefined> {
    const documentId = documentIdOf(letter.payload);
    if (documentId === undefined) {
      report.malformed.push(letter.messageId);
      return undefined;
    }
    let result: RequeueResult;
    try {
      result = await this.commands.execute(
        new RequeueDocumentCommand({
          documentId,
          reason: 'dlq-redrive',
          causationId: letter.messageId,
          dryRun,
        }),
      );
    } catch {
      report.failed.push(documentId);
      return undefined;
    }
    if (result.outcome === 'requeued') {
      report.requeued.push({ documentId, status: result.status, attempt: result.attempt });
    } else if (result.outcome === 'already-final') {
      report.alreadyFinal.push({ documentId, status: result.status });
    } else {
      report.notFound.push(documentId);
    }
    return result;
  }

  /** Ack once the requeue committed, or when the document needs nothing more. */
  private handled(result: RequeueResult | undefined, dryRun: boolean): boolean {
    return !dryRun && (result?.outcome === 'requeued' || result?.outcome === 'already-final');
  }
}

function documentIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { documentId } = payload as Record<string, unknown>;
  return typeof documentId === 'string' && documentId !== '' ? documentId : undefined;
}
