import { describe, expect, it } from 'vitest';
import { Document, MAX_PROCESSING_ATTEMPTS } from './document';
import type { DocumentEvent, FailureReason } from './document-events';
import { DomainError } from './errors';
import { ContentHash, IdempotencyKey, OrganisationId } from './value-objects';

const now = new Date('2026-11-12T10:00:00.000Z');
const outage: FailureReason = { code: 'VAT_SERVICE_UNAVAILABLE', message: 'down' };
const rejected: FailureReason = { code: 'BUSINESS_RULES_VIOLATED', message: 'BR-CO-15' };

const receive = () =>
  Document.receive(
    {
      documentId: 'd-1',
      organisationId: OrganisationId.parse('org-1'),
      idempotencyKey: IdempotencyKey.parse('k-1'),
      contentHash: ContentHash.parse('a'.repeat(64)),
      documentType: 'Invoice',
      direction: 'sales',
    },
    now,
  );

/** One document in each state the lifecycle can reach. */
const states = {
  Received: () => receive(),
  'Processing (attempt running)': () => {
    const document = receive();
    document.startProcessing(now);
    return document;
  },
  'Processing (attempt failed)': () => {
    const document = receive();
    document.startProcessing(now);
    document.recordTransientFailure(outage, now);
    return document;
  },
  Completed: () => {
    const document = receive();
    document.startProcessing(now);
    document.complete('documents/d-1/result.json', now);
    return document;
  },
  Failed: () => {
    const document = receive();
    document.startProcessing(now);
    document.fail(rejected, now);
    return document;
  },
};
type State = keyof typeof states;

const actions = {
  startProcessing: (document: Document) => document.startProcessing(now),
  complete: (document: Document) => document.complete('documents/d-1/result.json', now),
  fail: (document: Document) => document.fail(rejected, now),
  recordTransientFailure: (document: Document) => document.recordTransientFailure(outage, now),
};
type Action = keyof typeof actions;

/** The event the action records, or the code of the DomainError that refuses it. */
const outcomeOf = (document: Document, action: Action): string => {
  try {
    actions[action](document);
    return document.pendingEvents.at(-1)?.type ?? 'no event';
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected ${String(error)}`;
  }
};

describe('Document state machine', () => {
  // Every state × every command. Allowed transitions name the event they record.
  const matrix: Array<[State, Action, string]> = [
    ['Received', 'startProcessing', 'ProcessingStarted'],
    ['Received', 'complete', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Received', 'fail', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Received', 'recordTransientFailure', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Processing (attempt running)', 'startProcessing', 'ATTEMPT_IN_PROGRESS'],
    ['Processing (attempt running)', 'complete', 'DocumentProcessed'],
    ['Processing (attempt running)', 'fail', 'DocumentProcessingFailed'],
    ['Processing (attempt running)', 'recordTransientFailure', 'ProcessingAttemptFailed'],
    ['Processing (attempt failed)', 'startProcessing', 'ProcessingStarted'],
    ['Processing (attempt failed)', 'complete', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Processing (attempt failed)', 'fail', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Processing (attempt failed)', 'recordTransientFailure', 'NO_ATTEMPT_IN_PROGRESS'],
    ['Completed', 'startProcessing', 'DOCUMENT_FINAL'],
    ['Completed', 'complete', 'DOCUMENT_FINAL'],
    ['Completed', 'fail', 'DOCUMENT_FINAL'],
    ['Completed', 'recordTransientFailure', 'DOCUMENT_FINAL'],
    ['Failed', 'startProcessing', 'DOCUMENT_FINAL'],
    ['Failed', 'complete', 'DOCUMENT_FINAL'],
    ['Failed', 'fail', 'DOCUMENT_FINAL'],
    ['Failed', 'recordTransientFailure', 'DOCUMENT_FINAL'],
  ];

  it.each(matrix)('%s + %s → %s', (state, action, expected) => {
    const document = states[state]();
    const before = { status: document.status, pending: document.pendingEvents.length };
    expect(outcomeOf(document, action)).toBe(expected);
    if (/^[A-Z_]+$/.test(expected)) {
      // A refused command (DomainError code) changes nothing.
      expect(document.status).toBe(before.status);
      expect(document.pendingEvents).toHaveLength(before.pending);
    }
  });

  describe('transitions', () => {
    it('receive: Received, no attempt yet, one pending DocumentReceived at version 0', () => {
      const document = receive();
      expect(document).toMatchObject({ status: 'Received', attempts: 0, attemptInProgress: false });
      expect(document.version).toBe(0);
      expect(document.pendingEvents).toEqual([
        {
          type: 'DocumentReceived',
          documentId: 'd-1',
          organisationId: 'org-1',
          idempotencyKey: 'k-1',
          contentHash: 'a'.repeat(64),
          documentType: 'Invoice',
          direction: 'sales',
          receivedAt: now.toISOString(),
        },
      ]);
    });

    it('startProcessing: Processing with attempt 1 running', () => {
      const document = states['Processing (attempt running)']();
      expect(document).toMatchObject({
        status: 'Processing',
        attempts: 1,
        attemptInProgress: true,
      });
      expect(document.pendingEvents.at(-1)).toEqual({
        type: 'ProcessingStarted',
        attempt: 1,
        startedAt: now.toISOString(),
      });
    });

    it('recordTransientFailure below the maximum: retry, still Processing, attempt ended', () => {
      const document = states['Processing (attempt running)']();
      expect(document.recordTransientFailure(outage, now)).toBe('retry');
      expect(document).toMatchObject({
        status: 'Processing',
        attempts: 1,
        attemptInProgress: false,
        failure: outage,
      });
      expect(document.pendingEvents.at(-1)).toMatchObject({
        type: 'ProcessingAttemptFailed',
        attempt: 1,
        reason: outage,
      });
    });

    it('startProcessing after a failed attempt: attempt 2 runs, the last failure stays visible', () => {
      const document = states['Processing (attempt failed)']();
      document.startProcessing(now);
      expect(document).toMatchObject({ attempts: 2, attemptInProgress: true, failure: outage });
      expect(document.pendingEvents.at(-1)).toMatchObject({
        type: 'ProcessingStarted',
        attempt: 2,
      });
    });

    it('complete: Completed, and an earlier transient failure is cleared', () => {
      const document = states['Processing (attempt failed)']();
      document.startProcessing(now);
      document.complete('documents/d-1/result.json', now);
      expect(document).toMatchObject({ status: 'Completed', isFinal: true, failure: undefined });
      expect(document.pendingEvents.at(-1)).toEqual({
        type: 'DocumentProcessed',
        resultKey: 'documents/d-1/result.json',
        completedAt: now.toISOString(),
      });
    });

    it('fail: Failed with the reason, final', () => {
      const document = states.Failed();
      expect(document).toMatchObject({ status: 'Failed', isFinal: true, failure: rejected });
      expect(document.pendingEvents.at(-1)).toMatchObject({
        type: 'DocumentProcessingFailed',
        reason: rejected,
      });
    });

    it(`MAX_PROCESSING_ATTEMPTS is explicit: ${MAX_PROCESSING_ATTEMPTS} = the first attempt plus three retries`, () => {
      expect(MAX_PROCESSING_ATTEMPTS).toBe(4);
      const document = receive();
      const results: string[] = [];
      for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
        document.startProcessing(now);
        results.push(document.recordTransientFailure(outage, now));
      }
      expect(results).toEqual(['retry', 'retry', 'retry', 'exhausted']);
      expect(document).toMatchObject({ status: 'Failed', attempts: MAX_PROCESSING_ATTEMPTS });
      // The last attempt fails the document instead of recording another ProcessingAttemptFailed.
      expect(document.pendingEvents.map((e) => e.type).slice(-2)).toEqual([
        'ProcessingStarted',
        'DocumentProcessingFailed',
      ]);
      expect(document.failure).toEqual({
        code: 'VAT_SERVICE_UNAVAILABLE',
        message: 'down (gave up after 4 attempts)',
      });
    });

    it('recordTransientFailure honours a smaller maximum', () => {
      const document = states['Processing (attempt running)']();
      expect(document.recordTransientFailure(outage, now, 1)).toBe('exhausted');
      expect(document.status).toBe('Failed');
    });
  });

  describe('rehydration', () => {
    it.each(Object.keys(states) as State[])(
      'fromHistory restores %s with the same state and version',
      (state) => {
        const original = states[state]();
        const rehydrated = Document.fromHistory(original.pendingEvents);
        for (const field of [
          'id',
          'organisationId',
          'documentType',
          'direction',
          'status',
          'attempts',
          'attemptInProgress',
          'failure',
          'isFinal',
        ] as const) {
          expect(rehydrated[field]).toEqual(original[field]);
        }
        expect(rehydrated.version).toBe(original.pendingEvents.length);
        expect(rehydrated.pendingEvents).toEqual([]);
      },
    );

    it('markPersisted moves the pending events into the version', () => {
      const document = receive();
      document.markPersisted();
      document.startProcessing(now);
      expect(document.version).toBe(1);
      document.markPersisted();
      expect(document.version).toBe(2);
      expect(document.pendingEvents).toEqual([]);
    });

    it.each<[string, DocumentEvent[]]>([
      ['an empty stream', []],
      [
        'a stream that starts with ProcessingStarted',
        [{ type: 'ProcessingStarted', attempt: 1, startedAt: now.toISOString() }],
      ],
    ])('refuses %s with CORRUPT_STREAM', (_name, history) => {
      expect(() => Document.fromHistory(history)).toThrow(
        expect.objectContaining({ code: 'CORRUPT_STREAM' }),
      );
    });
  });
});
