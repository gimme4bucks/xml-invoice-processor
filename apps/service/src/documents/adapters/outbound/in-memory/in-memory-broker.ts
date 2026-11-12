import {
  MessagePublisher,
  type PublishOptions,
  PublishFailedError,
  RoutingKeys,
} from '../../../application/ports';

export interface DeliveredMessage {
  routingKey: string;
  payload: Record<string, unknown>;
  messageId: string;
  headers: Record<string, string>;
}

type Handler = (message: DeliveredMessage) => Promise<void>;

/**
 * Stand-in for RabbitMQ in the walking skeleton and in tests. Retry routing keys are delivered
 * to the `process` handler after `retryDelayMs`, mimicking the TTL delay queues. A handler that
 * throws gets the message again (at-least-once), up to `deliveryLimit` deliveries.
 */
export class InMemoryBroker extends MessagePublisher {
  private readonly handlers = new Map<string, Handler>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** When set, publish rejects with this reason (simulates an unavailable broker). */
  unavailable?: string;
  readonly deadLetters: DeliveredMessage[] = [];

  constructor(private readonly options: { retryDelayMs?: number; deliveryLimit?: number } = {}) {
    super();
  }

  consume(routingKey: string, handler: Handler): void {
    this.handlers.set(routingKey, handler);
  }

  async publish(
    routingKey: string,
    payload: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<void> {
    if (this.unavailable) throw new PublishFailedError(this.unavailable);
    const routable =
      routingKey === RoutingKeys.process ||
      (RoutingKeys.retry as readonly string[]).includes(routingKey);
    // Mirrors `mandatory` publishing: a message that would be dropped is a failed publish.
    if (!routable) throw new PublishFailedError(`unroutable routing key "${routingKey}"`);
    const message: DeliveredMessage = {
      routingKey,
      payload: structuredClone(payload),
      messageId: options.messageId,
      headers: { ...options.headers },
    };
    const isRetry = routingKey.startsWith('retry.');
    this.schedule(isRetry ? 'process' : routingKey, message, isRetry ? this.retryDelay : 0, 1);
  }

  /** Cancels pending deliveries (test teardown / shutdown). */
  close(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  private get retryDelay(): number {
    return this.options.retryDelayMs ?? 10;
  }

  private schedule(
    target: string,
    message: DeliveredMessage,
    delayMs: number,
    delivery: number,
  ): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.deliver(target, message, delivery);
    }, delayMs);
    this.timers.add(timer);
  }

  private async deliver(
    target: string,
    message: DeliveredMessage,
    delivery: number,
  ): Promise<void> {
    const handler = this.handlers.get(target);
    if (!handler) {
      this.deadLetters.push(message); // unroutable
      return;
    }
    try {
      await handler(message);
    } catch {
      if (delivery >= (this.options.deliveryLimit ?? 10)) this.deadLetters.push(message);
      else this.schedule(target, message, 0, delivery + 1);
    }
  }
}
