import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { DocumentEvent } from '../../domain/document-events';
import type { DocumentStatus, DocumentType } from '../../domain/value-objects';
import { resultBlobKey } from '../document-view';
import { DocumentNotFoundError } from '../errors';
import {
  BlobStore,
  type DocumentPage,
  type DocumentView,
  DocumentViews,
  EventStore,
} from '../ports';

// Queries read the read model and never load the aggregate (CQRS). Every query is scoped to the
// organisation from the access token; another organisation's document is "not found".

export class GetDocumentQuery {
  constructor(
    readonly organisationId: string,
    readonly documentId: string,
  ) {}
}

@QueryHandler(GetDocumentQuery)
export class GetDocumentHandler implements IQueryHandler<GetDocumentQuery, DocumentView> {
  constructor(private readonly views: DocumentViews) {}

  async execute({ organisationId, documentId }: GetDocumentQuery): Promise<DocumentView> {
    const view = await this.views.get(organisationId, documentId);
    if (!view) throw new DocumentNotFoundError(documentId);
    return view;
  }
}

export class ListDocumentsQuery {
  constructor(
    readonly organisationId: string,
    readonly options: {
      limit: number;
      cursor?: string;
      status?: DocumentStatus;
      documentType?: DocumentType;
    },
  ) {}
}

@QueryHandler(ListDocumentsQuery)
export class ListDocumentsHandler implements IQueryHandler<ListDocumentsQuery, DocumentPage> {
  constructor(private readonly views: DocumentViews) {}

  execute({ organisationId, options }: ListDocumentsQuery): Promise<DocumentPage> {
    return this.views.list(organisationId, options);
  }
}

export class GetDocumentResultQuery {
  constructor(
    readonly organisationId: string,
    readonly documentId: string,
  ) {}
}

/** The processing result (JSON), available once the document is Completed; undefined before that. */
@QueryHandler(GetDocumentResultQuery)
export class GetDocumentResultHandler implements IQueryHandler<
  GetDocumentResultQuery,
  { status: DocumentStatus; result?: unknown }
> {
  constructor(
    private readonly views: DocumentViews,
    private readonly blobs: BlobStore,
  ) {}

  async execute({ organisationId, documentId }: GetDocumentResultQuery) {
    const view = await this.views.get(organisationId, documentId);
    if (!view) throw new DocumentNotFoundError(documentId);
    if (view.status !== 'Completed') return { status: view.status };
    const blob = await this.blobs.get(resultBlobKey(documentId));
    return {
      status: view.status,
      result: blob ? (JSON.parse(blob.content.toString('utf8')) as unknown) : undefined,
    };
  }
}

export class GetDocumentHistoryQuery {
  constructor(
    readonly organisationId: string,
    readonly documentId: string,
  ) {}
}

export interface HistoryEntry {
  version: number;
  type: DocumentEvent['type'];
  occurredAt: Date;
  event: DocumentEvent;
}

/** The document's event stream: the audit trail that event sourcing gives us for free. */
@QueryHandler(GetDocumentHistoryQuery)
export class GetDocumentHistoryHandler implements IQueryHandler<
  GetDocumentHistoryQuery,
  HistoryEntry[]
> {
  constructor(
    private readonly views: DocumentViews,
    private readonly events: EventStore,
  ) {}

  async execute({ organisationId, documentId }: GetDocumentHistoryQuery): Promise<HistoryEntry[]> {
    if (!(await this.views.get(organisationId, documentId))) {
      throw new DocumentNotFoundError(documentId);
    }
    const stream = await this.events.load(documentId);
    return stream.map(({ version, event, occurredAt }) => ({
      version,
      type: event.type,
      occurredAt,
      event,
    }));
  }
}

export const queryHandlers = [
  GetDocumentHandler,
  ListDocumentsHandler,
  GetDocumentResultHandler,
  GetDocumentHistoryHandler,
];
