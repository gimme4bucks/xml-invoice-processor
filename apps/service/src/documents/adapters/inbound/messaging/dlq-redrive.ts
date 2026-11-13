import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
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
  dryRun: boolean;
  limit?: number;
}

export interface RedriveReport {
  dryRun: boolean;
  requeued: Array<{ documentId: string; status: DocumentStatus; attempt: number }>;
  alreadyFinal: Array<{ documentId: string; status: DocumentStatus }>;
  notFound: string[];
  failed: string[];
  malformed: string[];
}

export function leftInDlq(_report: RedriveReport): number {
  throw new Error('leftInDlq is not implemented yet');
}

export function parseRedriveArgs(_args: string[]): RedriveOptions {
  throw new Error('parseRedriveArgs is not implemented yet');
}

@Injectable()
export class DlqRedrive {
  constructor(
    private readonly source: DeadLetterSource,
    private readonly commands: CommandBus,
  ) {}

  run(_options: RedriveOptions): Promise<RedriveReport> {
    throw new Error('DlqRedrive is not implemented yet');
  }
}
