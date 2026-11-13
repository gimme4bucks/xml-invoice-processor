import type { AppConfig } from '../config';

/** A signed-in support employee. Lives in memory only (ADR 0018). */
export interface Session {
  accessToken: string;
  /** Epoch milliseconds after which the API refuses the token. */
  expiresAt: number;
  /** The employee (`sub`), for display only. */
  subject?: string;
}

/** The sign-in could not be completed; the message is safe to show (no code, no token). */
export class SignInError extends Error {
  override readonly name = 'SignInError';
}

export function startSignIn(_config: AppConfig, _navigate?: (url: string) => void): Promise<void> {
  return Promise.reject(new Error('Not implemented'));
}

export function completeSignIn(_config: AppConfig): Promise<Session> {
  return Promise.reject(new Error('Not implemented'));
}
