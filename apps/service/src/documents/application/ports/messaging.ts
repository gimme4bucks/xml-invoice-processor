export interface PublishOptions {
  messageId: string;
  headers?: Record<string, string>;
}

/** Thrown when the outcome of a publish is unknown (not confirmed in time, channel closed, nacked). */
export class PublishFailedError extends Error {
  constructor(reason: string) {
    super(`Publish not confirmed: ${reason}`);
    this.name = 'PublishFailedError';
  }
}

/**
 * Publishes to the message broker. Resolves only after the broker confirmed the message;
 * rejects with PublishFailedError otherwise. A rejection means "unknown", not "not delivered":
 * the message may still arrive, so consumers must be idempotent. Only the outbox relay uses this.
 */
export abstract class MessagePublisher {
  abstract publish(
    routingKey: string,
    payload: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<void>;
}

/** Routing keys of the documents exchange. Retry keys route to delay queues (TTL) that dead-letter back to `process`. */
export const RoutingKeys = {
  process: 'process',
  retry: ['retry.5s', 'retry.30s', 'retry.2m'],
} as const;

/** Payload of a `process` (or retry) message. */
export interface ProcessDocumentMessage extends Record<string, unknown> {
  documentId: string;
  /** The attempt this message asks for (1 for the first). */
  attempt: number;
}
