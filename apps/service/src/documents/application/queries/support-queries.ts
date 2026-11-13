import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { DocumentStatus, DocumentType } from '../../domain/value-objects';
import { DocumentNotFoundError } from '../errors';
import {
  type DocumentPage,
  type DocumentView,
  DocumentViews,
  EventStore,
  type StoredEvent,
} from '../ports';
import type { HistoryEntry } from './document-queries';

// Support queries (ADR 0017): read-only, across organisations, for a support employee's token.
// They return metadata, status, failure reasons and history; never the XML or the result, so no
// handler here touches the BlobStore.

export class SupportListDocumentsQuery {
  constructor(
    readonly options: {
      limit: number;
      cursor?: string;
      organisationId?: string;
      status?: DocumentStatus;
      documentType?: DocumentType;
    },
  ) {}
}

@QueryHandler(SupportListDocumentsQuery)
export class SupportListDocumentsHandler implements IQueryHandler<
  SupportListDocumentsQuery,
  DocumentPage
> {
  constructor(private readonly views: DocumentViews) {}

  execute({ options }: SupportListDocumentsQuery): Promise<DocumentPage> {
    return this.views.listAcrossOrganisations(options);
  }
}

/**
 * The organisation a document belongs to, from the first event of its stream. Support looks a
 * document up by id alone; the read model is then read with the owner's organisation as usual.
 */
async function ownedStream(events: EventStore, documentId: string) {
  const stream = await events.load(documentId);
  const first: StoredEvent | undefined = stream[0];
  if (first?.event.type !== 'DocumentReceived') throw new DocumentNotFoundError(documentId);
  return { organisationId: first.event.organisationId, stream };
}

export class SupportGetDocumentQuery {
  constructor(readonly documentId: string) {}
}

@QueryHandler(SupportGetDocumentQuery)
export class SupportGetDocumentHandler implements IQueryHandler<
  SupportGetDocumentQuery,
  DocumentView
> {
  constructor(
    private readonly views: DocumentViews,
    private readonly events: EventStore,
  ) {}

  async execute({ documentId }: SupportGetDocumentQuery): Promise<DocumentView> {
    const { organisationId } = await ownedStream(this.events, documentId);
    const view = await this.views.get(organisationId, documentId);
    if (!view) throw new DocumentNotFoundError(documentId);
    return view;
  }
}

export class SupportGetDocumentHistoryQuery {
  constructor(readonly documentId: string) {}
}

@QueryHandler(SupportGetDocumentHistoryQuery)
export class SupportGetDocumentHistoryHandler implements IQueryHandler<
  SupportGetDocumentHistoryQuery,
  HistoryEntry[]
> {
  constructor(private readonly events: EventStore) {}

  async execute({ documentId }: SupportGetDocumentHistoryQuery): Promise<HistoryEntry[]> {
    const { stream } = await ownedStream(this.events, documentId);
    return stream.map(({ version, event, occurredAt }) => ({
      version,
      type: event.type,
      occurredAt,
      event,
    }));
  }
}

export const supportQueryHandlers = [
  SupportListDocumentsHandler,
  SupportGetDocumentHandler,
  SupportGetDocumentHistoryHandler,
];
