import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supportApi } from './api/support-api';
import {
  CALLBACK_PATH,
  completeSignIn,
  type Session,
  SignInError,
  startSignIn,
} from './auth/sign-in';
import type { AppConfig } from './config';
import { DocumentDetail } from './ui/DocumentDetail';
import { DocumentList } from './ui/DocumentList';

type State =
  | { kind: 'signed-out'; notice?: string }
  | { kind: 'completing' }
  | { kind: 'signed-in'; session: Session };

/**
 * The support app. The session, and with it the access token, exists only in this component's
 * state: never in web storage, a cookie or the URL (ADR 0018). A reload starts signed out.
 */
export function App({ config }: { config: AppConfig }) {
  const [state, setState] = useState<State>(() =>
    window.location.pathname === CALLBACK_PATH ? { kind: 'completing' } : { kind: 'signed-out' },
  );
  const signOut = useCallback((notice?: string) => setState({ kind: 'signed-out', notice }), []);

  // The callback runs once, also when React runs effects twice in development.
  const completing = useRef(false);
  useEffect(() => {
    if (state.kind !== 'completing' || completing.current) return;
    completing.current = true;
    completeSignIn(config).then(
      (session) => setState({ kind: 'signed-in', session }),
      (error: unknown) =>
        signOut(error instanceof SignInError ? error.message : 'The sign-in failed.'),
    );
  }, [config, state.kind, signOut]);

  if (state.kind === 'signed-in') {
    return <SupportView config={config} session={state.session} onSignOut={signOut} />;
  }
  if (state.kind === 'completing') return <p className="page">Signing in…</p>;
  return <SignIn config={config} notice={state.notice} />;
}

function SignIn({ config, notice }: { config: AppConfig; notice?: string }) {
  const [problem, setProblem] = useState<string>();
  return (
    <main className="page sign-in">
      <h1>Support view</h1>
      <p>
        Follow documents across organisations, read-only. Every lookup is recorded under your name.
      </p>
      {(problem ?? notice) && (
        <p role="status" className="notice">
          {problem ?? notice}
        </p>
      )}
      <button
        type="button"
        onClick={() =>
          void startSignIn(config).catch(() => setProblem('The sign-in could not be started.'))
        }
      >
        Sign in
      </button>
      <p className="hint">
        The session lives in this tab&apos;s memory only: a reload, a new tab or closing the tab
        means signing in again.
      </p>
    </main>
  );
}

function SupportView({
  config,
  session,
  onSignOut,
}: {
  config: AppConfig;
  session: Session;
  onSignOut: (notice?: string) => void;
}) {
  const api = useMemo(
    () =>
      supportApi({
        apiUrl: config.apiUrl,
        session,
        onUnauthorized: () =>
          onSignOut(
            Date.now() >= session.expiresAt
              ? 'Your session has expired. Sign in again.'
              : 'The API no longer accepts your session. Sign in again.',
          ),
      }),
    [config.apiUrl, session, onSignOut],
  );
  const [open, setOpen] = useState<string>();

  return (
    <>
      <header className="bar">
        <span className="brand">Support view</span>
        {session.subject && <span>Signed in as {session.subject}</span>}
        <button type="button" onClick={() => onSignOut()}>
          Sign out
        </button>
      </header>
      <main className="page">
        {/* Hidden, not unmounted: the list keeps its filters and pages while a document is open. */}
        <div hidden={open !== undefined}>
          <DocumentList api={api} onOpen={setOpen} />
        </div>
        {open !== undefined && (
          <DocumentDetail api={api} documentId={open} onBack={() => setOpen(undefined)} />
        )}
      </main>
    </>
  );
}
