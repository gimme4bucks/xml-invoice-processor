// PKCE (RFC 7636) and `state` for the support app's sign-in (ADR 0018). Everything random comes
// from crypto.getRandomValues; the challenge is computed with crypto.subtle.

/** 32 random bytes give 43 base64url characters, RFC 7636's recommended verifier (§4.1). */
const VERIFIER_BYTES = 32;
/** 128 bits: a `state` nobody can guess, so a forged callback cannot match it. */
const STATE_BYTES = 16;

/** A new PKCE code verifier: 43 unreserved characters. */
export function createCodeVerifier(): string {
  return randomBase64Url(VERIFIER_BYTES);
}

/** A new `state` for one authorization request. */
export function createState(): string {
  return randomBase64Url(STATE_BYTES);
}

/** The S256 code challenge of a verifier: BASE64URL(SHA-256(ASCII(verifier))). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function randomBase64Url(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Base64url without padding (RFC 4648 §5), the encoding RFC 7636 uses. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
