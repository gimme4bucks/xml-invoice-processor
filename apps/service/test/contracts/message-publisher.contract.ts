import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MessagePublisher, PublishFailedError } from '../../src/documents/application/ports';

export interface DeliveredMessageView {
  payload: Record<string, unknown>;
  messageId: string;
  headers: Record<string, string>;
}

/**
 * Behaviour of the broker adapter as the outbox relay relies on it. Runs against the in-memory
 * broker (unit project) and the RabbitMQ adapter (contract project, work package G04).
 */
export interface MessagingHarness {
  publisher: MessagePublisher;
  /** Resolves with the next message delivered to the `process` queue. */
  nextProcessDelivery(timeoutMs: number): Promise<DeliveredMessageView>;
  /** Makes the broker unreachable for publishing, or undefined if the harness cannot. */
  simulateOutage?(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function describeMessagePublisherContract(
  name: string,
  createHarness: () => Promise<MessagingHarness>,
  options: { retryDelayMs: number },
): void {
  describe(`${name}: message publisher contract`, () => {
    let h: MessagingHarness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h.close();
    });

    it('delivers a confirmed message to the process queue with payload, messageId and headers', async () => {
      const messageId = randomUUID();
      await h.publisher.publish(
        'process',
        { documentId: 'd-1', attempt: 1 },
        {
          messageId,
          headers: { 'x-correlation-id': 'corr-1' },
        },
      );
      const delivered = await h.nextProcessDelivery(5_000);
      expect(delivered).toMatchObject({
        payload: { documentId: 'd-1', attempt: 1 },
        messageId,
        headers: { 'x-correlation-id': 'corr-1' },
      });
    });

    it('delivers a retry message to the process queue only after its delay', async () => {
      const messageId = randomUUID();
      const startedAt = Date.now();
      await h.publisher.publish('retry.5s', { documentId: 'd-2', attempt: 2 }, { messageId });
      const delivered = await h.nextProcessDelivery(options.retryDelayMs + 10_000);
      expect(delivered.messageId).toBe(messageId);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(options.retryDelayMs * 0.9);
    });

    it('rejects an unroutable message instead of confirming it (mandatory publishing)', async () => {
      await expect(
        h.publisher.publish('no-such-route', {}, { messageId: randomUUID() }),
      ).rejects.toBeInstanceOf(PublishFailedError);
    });

    it('rejects, rather than hangs, while the broker is unavailable', async () => {
      if (!h.simulateOutage) return;
      const restore = await h.simulateOutage();
      try {
        await expect(
          h.publisher.publish('process', {}, { messageId: randomUUID() }),
        ).rejects.toBeInstanceOf(PublishFailedError);
      } finally {
        await restore();
      }
    });
  });
}
