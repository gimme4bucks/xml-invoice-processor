import { ApiError } from '../api/support-api';

/**
 * An error as the API described it (Problem Details, RFC 9457): its title and stable code, the
 * detail, and when to try again. Like every value in the app, rendered as text.
 */
export function ProblemMessage({ error }: { error: unknown }) {
  const problem =
    error instanceof ApiError ? error : new ApiError(0, 'UNEXPECTED_ERROR', 'Something went wrong');
  return (
    <div role="alert" className="problem">
      <p>
        <strong>{problem.title}</strong> <code>{problem.code}</code>
      </p>
      {problem.detail && <p>{problem.detail}</p>}
      {problem.retryAfterSeconds !== undefined && (
        <p>Try again in {problem.retryAfterSeconds} seconds.</p>
      )}
    </div>
  );
}
