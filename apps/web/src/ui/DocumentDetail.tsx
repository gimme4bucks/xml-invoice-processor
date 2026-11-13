import { useEffect, useId, useState } from 'react';
import type { HistoryEntry, SupportApi, SupportDocument } from '../api/support-api';
import { formatTime } from './format';
import { ProblemMessage } from './ProblemMessage';

interface Loaded {
  document: SupportDocument;
  history: HistoryEntry[];
}

/**
 * One document as support sees it (ADR 0017): metadata, status, failure reasons and the event
 * history as a timeline. Never the XML or the processing result: the API does not offer them.
 */
export function DocumentDetail({
  api,
  documentId,
  onBack,
}: {
  api: SupportApi;
  documentId: string;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let current = true;
    Promise.all([api.getDocument(documentId), api.getHistory(documentId)]).then(
      ([document, history]) => {
        if (!current) return;
        const timeline = [...history].sort((a, b) => a.version - b.version);
        setLoaded({ document, history: timeline });
      },
      (failure: unknown) => current && setError(failure),
    );
    return () => {
      current = false;
    };
  }, [api, documentId]);

  return (
    <article className="detail">
      <button type="button" onClick={onBack}>
        ← Back to the list
      </button>
      {error !== undefined && <ProblemMessage error={error} />}
      {!loaded && error === undefined && <p aria-live="polite">Loading…</p>}
      {loaded && (
        <>
          <Metadata document={loaded.document} />
          {loaded.document.failure && <Failure document={loaded.document} />}
          <History history={loaded.history} />
        </>
      )}
    </article>
  );
}

function Region({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Metadata({ document }: { document: SupportDocument }) {
  const rows: [string, React.ReactNode][] = [
    ['Document id', <code>{document.documentId}</code>],
    ['Organisation', document.organisationId],
    ['Type', document.documentType],
    ['Direction', document.direction],
    [
      'Status',
      <span className="status" data-status={document.status}>
        {document.status}
      </span>,
    ],
    ['Attempts', document.attempts],
    ['Received', <Time iso={document.receivedAt} />],
    ['Updated', <Time iso={document.updatedAt} />],
    ...(document.completedAt
      ? [['Completed', <Time iso={document.completedAt} />] as [string, React.ReactNode]]
      : []),
  ];
  return (
    <Region title="Document">
      <dl>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Region>
  );
}

function Failure({ document }: { document: SupportDocument }) {
  const failure = document.failure!;
  return (
    <Region title="Failure">
      {document.status !== 'Failed' && <p>The last attempt failed; the document is retried.</p>}
      <p>
        <code>{failure.code}</code>
      </p>
      <p>{failure.message}</p>
      {failure.violations && failure.violations.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Flag</th>
              <th scope="col">Message</th>
              <th scope="col">Location</th>
            </tr>
          </thead>
          <tbody>
            {failure.violations.map((violation, index) => (
              <tr key={index}>
                <td>
                  <code>{violation.ruleId}</code>
                </td>
                <td>{violation.flag}</td>
                <td>{violation.message}</td>
                <td>
                  <code>{violation.location}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Region>
  );
}

function History({ history }: { history: HistoryEntry[] }) {
  return (
    <Region title="History">
      <ol className="timeline">
        {history.map((entry) => (
          <li key={entry.version}>
            <h3>{entry.type}</h3>
            <p>
              <span className="version">v{entry.version}</span> <Time iso={entry.occurredAt} />
            </p>
            <details>
              <summary>Event data</summary>
              <pre>{JSON.stringify(entry.event, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </Region>
  );
}

function Time({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatTime(iso)}</time>;
}
