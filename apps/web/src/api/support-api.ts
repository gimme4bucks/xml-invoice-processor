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

/**
 * The read-only support endpoints (ADR 0017), called with the session's bearer token and never
 * with cookies. A 401, or a token that has already expired, ends the session through
 * `onUnauthorized`, which sends the user back to sign in.
 */
export function supportApi(options: {
  apiUrl: string;
  session: Session;
  onUnauthorized: () => void;
}): SupportApi {
  const documents = `${options.apiUrl}/support/documents`;

  async function get<T>(url: string): Promise<T> {
    if (Date.now() >= options.session.expiresAt) {
      options.onUnauthorized();
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired');
    }
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${options.session.accessToken}` },
      credentials: 'omit',
    }).catch(() => {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the API',
        'Check the connection, and that this browser trusts the local CA (README, "Support view").',
      );
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 401) options.onUnauthorized();
    throw await toApiError(response);
  }

  return {
    listDocuments(filters, cursor) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries({ ...filters, cursor })) {
        if (value) query.set(name, value);
      }
      const search = query.size > 0 ? `?${query.toString()}` : '';
      return get<DocumentPage>(`${documents}${search}`);
    },
    getDocument(documentId) {
      return get<SupportDocument>(`${documents}/${encodeURIComponent(documentId)}`);
    },
    async getHistory(documentId) {
      const url = `${documents}/${encodeURIComponent(documentId)}/history`;
      return (await get<{ history: HistoryEntry[] }>(url)).history;
    },
  };
}

/** Problem Details when the API sent them; otherwise (an edge or proxy error) the status only. */
async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get('retry-after') ?? Number.NaN);
  const retryAfterSeconds = Number.isInteger(retryAfter) ? retryAfter : undefined;
  const problem = response.headers.get('content-type')?.includes('json')
    ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
    : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return new ApiError(
    response.status,
    text(problem.code) ?? `HTTP_${response.status}`,
    text(problem.title) ?? `The API answered ${response.status}`,
    text(problem.detail),
    retryAfterSeconds,
  );
}
