import { createHash } from 'node:crypto';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Document } from '../../domain/document';
import { determineDirection, PeppolParticipantId } from '../../domain/value-objects';
import { buildView, originalBlobKey } from '../document-view';
import { DocumentRejectedError, IdempotencyConflictError, NotAPartyError } from '../errors';
import {
  BlobStore,
  Clock,
  DocumentViews,
  EventStore,
  IdempotencyRaceError,
  IdempotencyRegistry,
  IdGenerator,
  InvoiceMapper,
  Outbox,
  RoutingKeys,
  StructureValidator,
  UnitOfWork,
} from '../ports';

export class SubmitDocumentCommand {
  constructor(
    readonly input: {
      organisationId: string;
      /** Peppol participant id of the organisation, from the access token. */
      peppolId: string;
      /** OAuth client id, recorded for the audit trail. */
      clientId: string;
      idempotencyKey: string;
      xml: Buffer;
      correlationId: string;
    },
  ) {}
}

export interface SubmitDocumentResult {
  documentId: string;
  /** True when this request repeated an earlier one (same key, same content). */
  replayed: boolean;
}

/**
 * Intake: validates the structure synchronously, then stores the document, its first event,
 * the read model row and the outbox message in one transaction. Only after that commit does the
 * client get 202, so an accepted document can never be lost.
 */
@CommandHandler(SubmitDocumentCommand)
export class SubmitDocumentHandler implements ICommandHandler<
  SubmitDocumentCommand,
  SubmitDocumentResult
> {
  constructor(
    private readonly structure: StructureValidator,
    private readonly mapper: InvoiceMapper,
    private readonly uow: UnitOfWork,
    private readonly events: EventStore,
    private readonly views: DocumentViews,
    private readonly blobs: BlobStore,
    private readonly outbox: Outbox,
    private readonly idempotency: IdempotencyRegistry,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute({ input }: SubmitDocumentCommand): Promise<SubmitDocumentResult> {
    const structure = this.structure.validate(input.xml);
    if (!structure.valid) throw new DocumentRejectedError(structure);

    const invoice = this.mapper.map(input.xml);
    const direction = determineDirection(
      PeppolParticipantId.parse(input.peppolId),
      invoice.supplier.endpointId,
      invoice.customer.endpointId,
    );
    if (!direction) throw new NotAPartyError();

    const contentHash = createHash('sha256').update(input.xml).digest('hex');
    const store = () => this.store(input, structure.documentType, direction, contentHash);
    try {
      return await store();
    } catch (error) {
      // A concurrent request won the unique index; the second try sees its committed row.
      if (error instanceof IdempotencyRaceError) return store();
      throw error;
    }
  }

  private store(
    input: SubmitDocumentCommand['input'],
    documentType: 'Invoice',
    direction: 'purchase' | 'sales',
    contentHash: string,
  ): Promise<SubmitDocumentResult> {
    return this.uow.run(async (tx) => {
      const documentId = this.ids.newId();
      const registration = await this.idempotency.register(
        {
          organisationId: input.organisationId,
          idempotencyKey: input.idempotencyKey,
          contentHash,
          documentId,
        },
        tx,
      );
      if (registration.outcome === 'replayed') {
        return { documentId: registration.documentId, replayed: true };
      }
      if (registration.outcome !== 'registered') {
        throw new IdempotencyConflictError(registration.outcome, registration.documentId);
      }

      const document = Document.receive(
        {
          documentId,
          organisationId: input.organisationId,
          idempotencyKey: input.idempotencyKey,
          contentHash,
          documentType,
          direction,
        },
        this.clock.now(),
      );
      const stored = await this.events.append(
        documentId,
        0,
        document.pendingEvents,
        { correlationId: input.correlationId, actor: input.clientId },
        tx,
      );
      await this.blobs.put(
        { key: originalBlobKey(documentId), contentType: 'application/xml', content: input.xml },
        tx,
      );
      await this.views.upsert(buildView(stored), tx);
      await this.outbox.enqueue(
        [
          {
            id: this.ids.newId(),
            routingKey: RoutingKeys.process,
            payload: { documentId, attempt: 1 },
            headers: { 'x-correlation-id': input.correlationId },
          },
        ],
        tx,
      );
      return { documentId, replayed: false };
    });
  }
}
