import { describe, expect, it } from 'vitest';
import { Document } from './document';
import { DomainError } from './errors';

const now = new Date('2026-11-12T10:00:00.000Z');
const receive = () =>
  Document.receive(
    {
      documentId: 'd-1',
      organisationId: 'org-1',
      idempotencyKey: 'k-1',
      contentHash: 'h-1',
      documentType: 'Invoice',
      direction: 'sales',
    },
    now,
  );

// Starter tests for the state machine; work package G01 completes the coverage.
describe('Document', () => {
  it('starts as Received with one pending event', () => {
    const document = receive();
    expect(document.status).toBe('Received');
    expect(document.pendingEvents.map((e) => e.type)).toEqual(['DocumentReceived']);
    expect(document.version).toBe(0);
  });

  it('rehydrates from history to the same state', () => {
    const original = receive();
    original.startProcessing(now);
    original.complete('documents/d-1/result.json', now);
    const rehydrated = Document.fromHistory(original.pendingEvents);
    expect(rehydrated.status).toBe('Completed');
    expect(rehydrated.attempts).toBe(1);
    expect(rehydrated.version).toBe(3);
  });

  it('gives up after the maximum number of attempts', () => {
    const document = receive();
    for (let attempt = 1; attempt <= 3; attempt++) {
      document.startProcessing(now);
      expect(document.recordTransientFailure({ code: 'X', message: 'down' }, now, 3)).toBe(
        attempt < 3 ? 'retry' : 'exhausted',
      );
    }
    expect(document.status).toBe('Failed');
  });

  it('refuses changes once final', () => {
    const document = receive();
    document.fail({ code: 'X', message: 'no' }, now);
    expect(() => document.startProcessing(now)).toThrow(DomainError);
  });
});
