import { createHash } from 'node:crypto';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Document } from '../../domain/document';
import {
  ContentHash,
  determineDirection,
  type DocumentType,
  IdempotencyKey,
  type InvoiceDirection,
  OrganisationId,
  PeppolParticipantId,
} from '../../domain/value-objects';
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

/**
 * Raw values from the access token and the request. The handler parses them into value objects
 * and rejects invalid ones with a DomainError (stable code), whichever inbound adapter sent them.
 */
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

/** The validated command input, as stored in one unit of work. */
interface Intake {
  organisationId: OrganisationId;
  idempotencyKey: IdempotencyKey;
  contentHash: ContentHash;
  documentType: DocumentType;
  direction: InvoiceDirection;
  xml: Buffer;
  clientId: string;
  correlationId: string;
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
    // Cheap input checks first; each throws a DomainError with a stable code.
    const organisationId = OrganisationId.parse(input.organisationId);
    const idempotencyKey = IdempotencyKey.parse(input.idempotencyKey);
    const peppolId = PeppolParticipantId.parse(input.peppolId);

    const structure = this.structure.validate(input.xml);
    if (!structure.valid) throw new DocumentRejectedError(structure);

    const invoice = this.mapper.map(input.xml);
    const direction = determineDirection(
      peppolId,
      invoice.supplier.endpointId,
      invoice.customer.endpointId,
    );
    if (!direction) throw new NotAPartyError();

    const intake: Intake = {
      organisationId,
      idempotencyKey,
      contentHash: ContentHash.parse(createHash('sha256').update(input.xml).digest('hex')),
      documentType: structure.documentType,
      direction,
      xml: input.xml,
      clientId: input.clientId,
      correlationId: input.correlationId,
    };
    try {
      return await this.store(intake);
    } catch (error) {
      // A concurrent request won the unique index; the second try sees its committed row.
      if (error instanceof IdempotencyRaceError) return this.store(intake);
      throw error;
    }
  }

  private store(intake: Intake): Promise<SubmitDocumentResult> {
    return this.uow.run(async (tx) => {
      const documentId = this.ids.newId();
      const registration = await this.idempotency.register(
        {
          organisationId: intake.organisationId.value,
          idempotencyKey: intake.idempotencyKey.value,
          contentHash: intake.contentHash.value,
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
          organisationId: intake.organisationId,
          idempotencyKey: intake.idempotencyKey,
          contentHash: intake.contentHash,
          documentType: intake.documentType,
          direction: intake.direction,
        },
        this.clock.now(),
      );
      const stored = await this.events.append(
        documentId,
        0,
        document.pendingEvents,
        { correlationId: intake.correlationId, actor: intake.clientId },
        tx,
      );
      await this.blobs.put(
        { key: originalBlobKey(documentId), contentType: 'application/xml', content: intake.xml },
        tx,
      );
      await this.views.upsert(buildView(stored), tx);
      await this.outbox.enqueue(
        [
          {
            id: this.ids.newId(),
            routingKey: RoutingKeys.process,
            payload: { documentId, attempt: 1 },
            headers: { 'x-correlation-id': intake.correlationId },
          },
        ],
        tx,
      );
      return { documentId, replayed: false };
    });
  }
}
