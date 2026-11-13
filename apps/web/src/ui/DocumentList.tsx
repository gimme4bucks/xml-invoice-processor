import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  DocumentStatus,
  DocumentType,
  ListFilters,
  SupportApi,
  SupportDocument,
} from '../api/support-api';
import { formatTime } from './format';
import { ProblemMessage } from './ProblemMessage';

const statuses: DocumentStatus[] = ['Received', 'Processing', 'Completed', 'Failed'];
const types: DocumentType[] = ['Invoice', 'CreditNote'];
const noFilters: Required<ListFilters> = { organisationId: '', status: '', type: '' };

interface Page {
  filters: Required<ListFilters>;
  items: SupportDocument[];
  nextCursor?: string;
}

/** Documents of every organisation, newest first, with filters and "load more" (cursor paging). */
export function DocumentList({
  api,
  onOpen,
}: {
  api: SupportApi;
  onOpen: (documentId: string) => void;
}) {
  const [draft, setDraft] = useState(noFilters);
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  // Only the latest request may change the list: an older answer arriving late is dropped.
  const latest = useRef(0);
  const ids = { organisation: useId(), status: useId(), type: useId() };

  const load = useCallback(
    async (filters: Required<ListFilters>, previous?: Page) => {
      const request = ++latest.current;
      setLoading(true);
      setError(undefined);
      try {
        const result = await api.listDocuments(filters, previous?.nextCursor);
        if (request !== latest.current) return;
        setPage({
          filters,
          items: previous ? [...previous.items, ...result.items] : result.items,
          nextCursor: result.nextCursor,
        });
      } catch (failure) {
        if (request === latest.current) setError(failure);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load(noFilters);
  }, [load]);

  return (
    <section aria-label="Documents">
      <form
        className="filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void load(draft);
        }}
      >
        <label htmlFor={ids.organisation}>Organisation</label>
        <input
          id={ids.organisation}
          value={draft.organisationId}
          placeholder="Any, or an id like org-supplier"
          onChange={(event) => setDraft({ ...draft, organisationId: event.target.value.trim() })}
        />
        <label htmlFor={ids.status}>Status</label>
        <select
          id={ids.status}
          value={draft.status}
          onChange={(event) =>
            setDraft({ ...draft, status: event.target.value as DocumentStatus | '' })
          }
        >
          <option value="">Any</option>
          {statuses.map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>
        <label htmlFor={ids.type}>Type</label>
        <select
          id={ids.type}
          value={draft.type}
          onChange={(event) =>
            setDraft({ ...draft, type: event.target.value as DocumentType | '' })
          }
        >
          <option value="">Any</option>
          {types.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <button type="submit">Apply filters</button>
      </form>

      {error !== undefined && <ProblemMessage error={error} />}

      {page && page.items.length === 0 && <p>No documents match these filters.</p>}
      {page && page.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Organisation</th>
              <th scope="col">Type</th>
              <th scope="col">Direction</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Document</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((document) => (
              <tr key={document.documentId}>
                <td>
                  <time dateTime={document.receivedAt}>{formatTime(document.receivedAt)}</time>
                </td>
                <td>{document.organisationId}</td>
                <td>{document.documentType}</td>
                <td>{document.direction}</td>
                <td>
                  <span className="status" data-status={document.status}>
                    {document.status}
                  </span>
                </td>
                <td>{document.attempts}</td>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpen(document.documentId)}
                  >
                    {document.documentId}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {loading && <p aria-live="polite">Loading…</p>}
      {page?.nextCursor && !loading && (
        <button type="button" onClick={() => void load(page.filters, page)}>
          Load more
        </button>
      )}
    </section>
  );
}
