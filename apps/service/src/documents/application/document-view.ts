import { Document } from '../domain/document';
import type { DocumentView, StoredEvent } from './ports';

export const originalBlobKey = (documentId: string): string =>
  `documents/${documentId}/original.xml`;
export const resultBlobKey = (documentId: string): string => `documents/${documentId}/result.json`;

/** Projects the read model row from the full stream (a document has only a handful of events). */
export function buildView(history: readonly StoredEvent[]): DocumentView {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || first.event.type !== 'DocumentReceived') {
    throw new Error('Cannot project an empty or corrupt stream');
  }
  const document = Document.fromHistory(history.map((stored) => stored.event));
  const completed = history.find((stored) => stored.event.type === 'DocumentProcessed');
  return {
    documentId: document.id,
    organisationId: document.organisationId,
    documentType: document.documentType,
    direction: document.direction,
    status: document.status,
    attempts: document.attempts,
    ...(document.failure ? { failure: document.failure } : {}),
    receivedAt: new Date(first.event.receivedAt),
    updatedAt: last.occurredAt,
    ...(completed ? { completedAt: completed.occurredAt } : {}),
    version: last.version,
  };
}
