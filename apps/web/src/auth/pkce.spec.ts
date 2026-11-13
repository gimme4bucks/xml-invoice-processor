import { describe, expect, it, vi } from 'vitest';
import { codeChallenge, createCodeVerifier, createState } from './pkce';

// RFC 7636 §4.1: 43 to 128 characters from the unreserved set.
const UNRESERVED = /^[A-Za-z0-9\-._~]{43,128}$/;

describe('PKCE helpers (RFC 7636)', () => {
  it("computes the S256 challenge of Appendix B's example verifier", async () => {
    await expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates verifiers of 43 to 128 unreserved characters', () => {
    for (let i = 0; i < 100; i++) expect(createCodeVerifier()).toMatch(UNRESERVED);
  });

  it('takes the verifier and the state from crypto.getRandomValues', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const verifiers = new Set([createCodeVerifier(), createCodeVerifier()]);
    const states = new Set([createState(), createState()]);

    expect(random).toHaveBeenCalledTimes(4);
    expect(verifiers.size).toBe(2);
    expect(states.size).toBe(2);
  });

  it('creates a state of at least 128 bits, safe in a URL', () => {
    const state = createState();

    expect(state).toMatch(/^[A-Za-z0-9\-_]{22,}$/);
  });
});
