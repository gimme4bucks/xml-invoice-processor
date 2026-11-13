import type { Session } from '../auth/sign-in';

export type DocumentStatus = 'Received' | 'Processing' | 'Completed' | 'Failed';
export type DocumentType = 'Invoice' | 'CreditNote';

export interface RuleViolation {
  ruleId: string;
  flag: 'fatal' | 'warning';
  message: string;
  location: string;
}

export interface FailureReason {
  code: string;
  message: string;
  violations?: RuleViolation[];
}

/** GET /support/documents/{id}: metadata, status and failure, never the XML or the result. */
export interface SupportDocument {
  documentId: string;
  organisationId: string;
  documentType: DocumentType;
  direction: 'purchase' | 'sales';
  status: DocumentStatus;
  attempts: number;
  failure?: FailureReason;
  receivedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DocumentPage {
  items: SupportDocument[];
  nextCursor?: string;
}

export interface HistoryEntry {
  version: number;
  type: string;
  occurredAt: string;
  event: Record<string, unknown>;
}

/** The list's filters; an empty value means "any". */
export interface ListFilters {
  organisationId?: string;
  status?: DocumentStatus | '';
  type?: DocumentType | '';
}

/** A failed request, from Problem Details (RFC 9457) when the API sent them. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
  }
}

export interface SupportApi {
  listDocuments(filters: ListFilters, cursor?: string): Promise<DocumentPage>;
  getDocument(documentId: string): Promise<SupportDocument>;
  getHistory(documentId: string): Promise<HistoryEntry[]>;
}

export function supportApi(_options: {
  apiUrl: string;
  session: Session;
  onUnauthorized: () => void;
}): SupportApi {
  const notImplemented = () => Promise.reject(new Error('Not implemented'));
  return { listDocuments: notImplemented, getDocument: notImplemented, getHistory: notImplemented };
}
