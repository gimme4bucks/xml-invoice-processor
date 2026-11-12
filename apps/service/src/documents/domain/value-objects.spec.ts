import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  ContentHash,
  determineDirection,
  IdempotencyKey,
  OrganisationId,
  PeppolParticipantId,
} from './value-objects';

const codeOf = (parse: () => unknown): string | undefined => {
  try {
    parse();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected ${String(error)}`;
  }
};

describe('IdempotencyKey', () => {
  it.each([
    ['a single character', 'a'],
    ['255 characters', 'k'.repeat(255)],
    ['a UUID', '5f0c7d0e-8a51-4c6b-9d0a-3b1f2e4c5a6d'],
    ['spaces and punctuation', 'order 42/2026-11-12T10:00:00Z ~!@#$%^&*()"\\'],
  ])('accepts %s', (_name, raw) => {
    expect(IdempotencyKey.parse(raw).value).toBe(raw);
  });

  it.each([
    ['an empty key', ''],
    ['256 characters', 'k'.repeat(256)],
    ['a newline', 'a\nb'],
    ['a tab', 'a\tb'],
    ['a NUL byte', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['a non-ASCII character', 'sleutel-é'],
  ])('rejects %s with INVALID_IDEMPOTENCY_KEY', (_name, raw) => {
    expect(codeOf(() => IdempotencyKey.parse(raw))).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('does not echo the rejected key in the message', () => {
    expect(() => IdempotencyKey.parse('my-secret\n')).toThrow(
      /^The Idempotency-Key must be 1 to 255 printable ASCII characters$/,
    );
  });
});

describe('OrganisationId', () => {
  it('accepts a non-empty id as is', () => {
    expect(OrganisationId.parse('org-1').value).toBe('org-1');
    expect(String(OrganisationId.parse('org-1'))).toBe('org-1');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \t'],
  ])('rejects an id that is %s with INVALID_ORGANISATION_ID', (_name, raw) => {
    expect(codeOf(() => OrganisationId.parse(raw))).toBe('INVALID_ORGANISATION_ID');
  });
});

describe('ContentHash', () => {
  // SHA-256 of the empty string.
  const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('accepts a SHA-256 digest as 64 lowercase hex characters', () => {
    expect(ContentHash.parse(emptySha256).value).toBe(emptySha256);
  });

  it.each([
    ['empty', ''],
    ['63 characters', emptySha256.slice(1)],
    ['65 characters', `${emptySha256}0`],
    ['uppercase hex', emptySha256.toUpperCase()],
    ['non-hex characters', 'g'.repeat(64)],
  ])('rejects %s with INVALID_CONTENT_HASH', (_name, raw) => {
    expect(codeOf(() => ContentHash.parse(raw))).toBe('INVALID_CONTENT_HASH');
  });
});

describe('PeppolParticipantId', () => {
  it('parses scheme and value', () => {
    const id = PeppolParticipantId.parse('0106:12345678');
    expect(id).toMatchObject({ scheme: '0106', value: '12345678' });
    expect(id.toString()).toBe('0106:12345678');
  });

  it('ignores surrounding whitespace', () => {
    expect(PeppolParticipantId.parse('  0190:00000000123 ').toString()).toBe('0190:00000000123');
  });

  it.each([
    ['empty', ''],
    ['without a scheme', '12345678'],
    ['a three-digit scheme', '106:12345678'],
    ['a non-numeric scheme', 'abcd:12345678'],
    ['an empty value', '0106:'],
    ['an empty scheme', ':12345678'],
  ])('rejects %s with INVALID_PEPPOL_ID', (_name, raw) => {
    expect(codeOf(() => PeppolParticipantId.parse(raw))).toBe('INVALID_PEPPOL_ID');
  });

  it('compares the value case-insensitively, as Peppol prescribes', () => {
    const a = PeppolParticipantId.parse('9944:NL001234567B01');
    expect(a.equals(PeppolParticipantId.parse('9944:nl001234567b01'))).toBe(true);
  });

  it('is not equal to the same value under another scheme', () => {
    const a = PeppolParticipantId.parse('0106:12345678');
    expect(a.equals(PeppolParticipantId.parse('0190:12345678'))).toBe(false);
  });
});

describe('determineDirection', () => {
  const supplier = PeppolParticipantId.parse('0106:11111111');
  const customer = PeppolParticipantId.parse('0106:22222222');

  it('the supplier submits a sales invoice', () => {
    expect(determineDirection(supplier, supplier, customer)).toBe('sales');
  });

  it('the customer submits a purchase invoice', () => {
    expect(determineDirection(customer, supplier, customer)).toBe('purchase');
  });

  it('an organisation that is neither party gets no direction', () => {
    const other = PeppolParticipantId.parse('0106:33333333');
    expect(determineDirection(other, supplier, customer)).toBeUndefined();
  });
});
