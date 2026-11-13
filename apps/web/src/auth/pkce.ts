/** A new PKCE code verifier. */
export function createCodeVerifier(): string {
  throw new Error('Not implemented');
}

/** A new `state` for one authorization request. */
export function createState(): string {
  throw new Error('Not implemented');
}

/** The S256 code challenge of a verifier. */
export function codeChallenge(_verifier: string): Promise<string> {
  return Promise.reject(new Error('Not implemented'));
}
