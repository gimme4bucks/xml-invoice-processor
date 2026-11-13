import { performance } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ProcessDocumentCommand,
  type ProcessOutcome,
} from '../../../application/commands/process-document';
import type { ProcessDocumentMessage } from '../../../application/ports';

/** A `process` (or retry) message as a consumer received it, whatever the broker. */
export interface IncomingProcessMessage {
  /** The parsed JSON body; anything else is a malformed message. */
  payload: unknown;
  messageId: string;
  headers: Record<string, unknown>;
}

/** What one handled message ends in: the handler's outcome, or `requeued` after an error. */
export type MessageOutcome = ProcessOutcome | 'requeued';

/**
 * Turns a message into a ProcessDocumentCommand and writes one info line per handled message:
 * IDs, attempt, outcome and duration. Never the payload beyond its IDs, and never the error
 * message (it may quote input); the consumer logs the failure itself.
 */
@Injectable()
export class ProcessMessageDispatcher {
  private readonly logger = new Logger('ProcessMessages');

  constructor(private readonly commands: CommandBus) {}

  /** Resolves after the handler's transaction committed; rejects when the message must be requeued. */
  async dispatch(message: IncomingProcessMessage): Promise<ProcessOutcome> {
    const startedAt = performance.now();
    const fields = logFields(message);
    const log = (outcome: MessageOutcome) =>
      this.logger.log({
        msg: 'Message handled',
        ...fields,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      });
    try {
      const outcome: ProcessOutcome = await this.commands.execute(toCommand(message, fields));
      log(outcome);
      return outcome;
    } catch (error) {
      log('requeued');
      throw error;
    }
  }
}

interface LogFields {
  documentId?: string;
  attempt?: number;
  correlationId: string;
  messageId: string;
}

function logFields({ payload, messageId, headers }: IncomingProcessMessage): LogFields {
  const { documentId, attempt } = (isObject(payload) ? payload : {}) as Partial<
    Record<keyof ProcessDocumentMessage, unknown>
  >;
  const correlationId = headers['x-correlation-id'];
  return {
    ...(typeof documentId === 'string' ? { documentId } : {}),
    ...(Number.isInteger(attempt) ? { attempt: Number(attempt) } : {}),
    correlationId: typeof correlationId === 'string' ? correlationId : messageId,
    messageId,
  };
}

/** A malformed message throws, so it is requeued until the delivery limit sends it to the DLQ. */
function toCommand(message: IncomingProcessMessage, fields: LogFields): ProcessDocumentCommand {
  const { documentId, attempt, correlationId, messageId } = fields;
  if (documentId === undefined || attempt === undefined || attempt < 1) {
    throw new Error('Malformed process message: documentId or attempt missing');
  }
  return new ProcessDocumentCommand({ documentId, attempt, messageId, correlationId });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
