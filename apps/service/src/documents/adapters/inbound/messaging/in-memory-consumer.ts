import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ProcessDocumentCommand } from '../../../application/commands/process-document';
import { MessagePublisher, RoutingKeys } from '../../../application/ports';
import { InMemoryBroker } from '../../outbound/in-memory/in-memory-broker';

/** Inbound adapter for the walking skeleton: feeds in-memory broker deliveries to the command bus. */
@Injectable()
export class InMemoryDocumentConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly publisher: MessagePublisher,
    private readonly commands: CommandBus,
  ) {}

  onApplicationBootstrap(): void {
    if (!(this.publisher instanceof InMemoryBroker)) return;
    this.publisher.consume(RoutingKeys.process, async (message) => {
      await this.commands.execute(
        new ProcessDocumentCommand({
          documentId: String(message.payload['documentId']),
          attempt: Number(message.payload['attempt']),
          messageId: message.messageId,
          correlationId: message.headers['x-correlation-id'] ?? message.messageId,
        }),
      );
    });
  }
}
