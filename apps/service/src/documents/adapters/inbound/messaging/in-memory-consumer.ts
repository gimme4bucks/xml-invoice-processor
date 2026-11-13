import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { MessagePublisher, RoutingKeys } from '../../../application/ports';
import { InMemoryBroker } from '../../outbound/in-memory/in-memory-broker';
import { ProcessMessageDispatcher } from './process-message-dispatcher';

/** Inbound adapter for the walking skeleton: feeds in-memory broker deliveries to the dispatcher. */
@Injectable()
export class InMemoryDocumentConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly publisher: MessagePublisher,
    private readonly dispatcher: ProcessMessageDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    if (!(this.publisher instanceof InMemoryBroker)) return;
    this.publisher.consume(RoutingKeys.process, async (message) => {
      await this.dispatcher.dispatch(message);
    });
  }
}
