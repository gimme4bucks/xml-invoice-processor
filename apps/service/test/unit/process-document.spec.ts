import { describe, expect, it, vi } from 'vitest';
import {
  MessagePublisher,
  type OutboxMessage,
  type PublishOptions,
  PublishFailedError,
  RoutingKeys,
} from '../../src/documents/application/ports';
import { OutboxRelay } from '../../src/documents/application/relay/outbox-relay';
import { MAX_PROCESSING_ATTEMPTS } from '../../src/documents/domain/document';
import type { RuleViolation } from '../../src/documents/domain/document-events';
import { peppolFixture } from '../fixtures/peppol';
import {
  createHarness,
  customer,
  customerVat,
  fixture,
  supplier,
  supplierVat,
} from './support/harness';

const crash = () => new Error('worker crashed');

/** Records what the relay publishes; can lose confirms (the broker has it, the relay does not know). */
class RecordingBroker extends MessagePublisher {
  readonly delivered: OutboxMessage[] = [];
  loseConfirms = 0;

  async publish(
    routingKey: string,
    payload: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<void> {
    this.delivered.push({
      id: options.messageId,
      routingKey,
      payload,
      headers: { ...options.headers },
    });
    if (this.loseConfirms > 0) {
      this.loseConfirms--;
      throw new PublishFailedError('confirm timed out');
    }
  }
}

/** Submits the fixture and returns its document id and the `process` message. */
const submitted = async (h: ReturnType<typeof createHarness>, org = supplier) => {
  const { documentId } = await h.submit({ org });
  return { documentId, message: h.lastMessage() };
};

describe('ProcessDocumentHandler (in-memory adapters)', () => {
  it('happy path: ProcessingStarted then DocumentProcessed, result stored, view Completed', async () => {
    const h = createHarness();
    const { documentId, message } = await submitted(h);

    expect(await h.deliver(message)).toBe('completed');

    const history = await h.events.load(documentId);
    expect(history.map((s) => s.event.type)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
    expect(history[1]?.metadata).toEqual({
      correlationId: 'c-key-1',
      causationId: message.id,
      actor: 'worker',
    });
    expect(await h.view(documentId)).toMatchObject({
      status: 'Completed',
      attempts: 1,
      version: 3,
      completedAt: expect.any(Date),
    });
    expect(await h.blobs.get(`documents/${documentId}/result.json`)).toBeDefined();
    expect(h.outboxMessages()).toHaveLength(1);
  });

  describe('credit notes', () => {
    const creditNote = peppolFixture('credit-note');

    it('completes a credit note: documentType CreditNote, result under creditNote', async () => {
      const h = createHarness();
      const { documentId } = await h.submit({ xml: creditNote });
      expect(await h.view(documentId)).toMatchObject({
        documentType: 'CreditNote',
        direction: 'sales',
      });

      expect(await h.deliver(h.lastMessage())).toBe('completed');

      expect(await h.view(documentId)).toMatchObject({ status: 'Completed' });
      const blob = await h.blobs.get(`documents/${documentId}/result.json`);
      const result = JSON.parse(blob?.content.toString('utf8') ?? '{}') as Record<string, unknown>;
      expect(result).toMatchObject({
        documentId,
        direction: 'sales',
        creditNote: { documentType: 'CreditNote', creditNoteNumber: 'CN-2026-0007' },
      });
      expect(result).not.toHaveProperty('invoice');
    });

    it("purchase credit note: checks the supplier's VAT number, as for an invoice", async () => {
      const h = createHarness();
      h.vat.invalid.add(supplierVat);
      const { documentId } = await h.submit({ org: customer, xml: creditNote });
      expect(await h.view(documentId, customer)).toMatchObject({ direction: 'purchase' });

      expect(await h.deliver(h.lastMessage())).toBe('failed');
      expect(await h.view(documentId, customer)).toMatchObject({
        status: 'Failed',
        failure: { code: 'VAT_NUMBER_INVALID' },
      });
    });
  });

  describe('crashes and duplicate deliveries', () => {
    it('crash after ProcessingStarted committed: the redelivered message resumes the same attempt and completes', async () => {
      const h = createHarness();
      const { documentId, message } = await submitted(h);
      // The worker dies after the claim committed and before the rules ran: no ack, so the
      // broker redelivers the same message.
      vi.spyOn(h.rules, 'validate').mockRejectedValueOnce(crash());
      await expect(h.deliver(message)).rejects.toThrow('worker crashed');
      expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived', 'ProcessingStarted']);
      expect(await h.view(documentId)).toMatchObject({ status: 'Processing', attempts: 1 });

      expect(await h.deliver(message)).toBe('completed');

      const events = await h.eventsOf(documentId);
      expect(events.map((e) => e.type)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'DocumentProcessed',
      ]);
      expect(events.filter((e) => e.type === 'ProcessingStarted')).toEqual([
        expect.objectContaining({ attempt: 1 }),
      ]);
    });

    it('duplicate delivery after completion: skipped, with no new events', async () => {
      const h = createHarness();
      const { documentId, message } = await submitted(h);
      expect(await h.deliver(message)).toBe('completed');
      const before = await h.events.load(documentId);

      // E.g. the worker crashed between commit and ack.
      expect(await h.deliver(message)).toBe('skipped');

      expect(await h.events.load(documentId)).toEqual(before);
      expect(h.outboxMessages()).toHaveLength(1);
    });

    it('duplicate delivery after a permanent failure: skipped, with no new events', async () => {
      const h = createHarness();
      h.vat.invalid.add(customerVat);
      const { documentId, message } = await submitted(h);
      expect(await h.deliver(message)).toBe('failed');
      const before = await h.events.load(documentId);

      expect(await h.deliver(message)).toBe('skipped');

      expect(await h.events.load(documentId)).toEqual(before);
    });

    it('duplicate delivery of an attempt that already failed transiently: skipped, no second retry', async () => {
      const h = createHarness();
      h.vat.failNext = 1;
      const { documentId, message } = await submitted(h);
      expect(await h.deliver(message)).toBe('retry-scheduled');
      const retry = h.lastMessage();

      // The attempt-1 message again (crash between commit and ack). Attempt 1 has ended and its
      // retry message is already in the outbox, so there is nothing left to do.
      expect(await h.deliver(message)).toBe('skipped');
      expect(h.outboxMessages().map((m) => m.routingKey)).toEqual(['process', 'retry.5s']);

      expect(await h.deliver(retry)).toBe('completed');
      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'ProcessingAttemptFailed',
        'ProcessingStarted',
        'DocumentProcessed',
      ]);
    });

    it('stale message for an earlier attempt: skipped', async () => {
      const h = createHarness();
      h.vat.failNext = 1;
      const { documentId, message } = await submitted(h);
      await h.deliver(message);
      expect(await h.deliver(h.lastMessage())).toBe('completed');
      const before = await h.events.load(documentId);

      expect(await h.deliver(message)).toBe('skipped');

      expect(await h.events.load(documentId)).toEqual(before);
    });

    it('message for a document that does not exist: skipped', async () => {
      const h = createHarness();
      const message: OutboxMessage = {
        id: 'm-1',
        routingKey: 'process',
        payload: { documentId: 'unknown', attempt: 1 },
        headers: {},
      };
      expect(await h.deliver(message)).toBe('skipped');
    });
  });

  describe('concurrent deliveries of the same message', () => {
    it('two concurrent deliveries: exactly one terminal event, the loser returns skipped', async () => {
      const h = createHarness();
      const { documentId, message } = await submitted(h);

      const outcomes = await Promise.all([h.deliver(message), h.deliver(message)]);

      expect(outcomes.sort()).toEqual(['completed', 'skipped']);
      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'DocumentProcessed',
      ]);
    });

    it('two concurrent deliveries during a VAT outage: one ProcessingAttemptFailed, one retry message', async () => {
      const h = createHarness();
      h.vat.failNext = 2;
      const { documentId, message } = await submitted(h);

      const outcomes = await Promise.all([h.deliver(message), h.deliver(message)]);

      expect(outcomes.sort()).toEqual(['retry-scheduled', 'skipped']);
      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'ProcessingAttemptFailed',
      ]);
      expect(h.outboxMessages().map((m) => m.routingKey)).toEqual(['process', 'retry.5s']);
    });

    // The in-memory unit of work serialises transactions. On Postgres two workers can read the
    // same stream version before either commits; replaying that stale read reproduces it here.
    it('both claim at version 1: the second ProcessingStarted loses on (stream, version), skipped', async () => {
      const h = createHarness();
      const { documentId, message } = await submitted(h);
      const atVersion1 = await h.events.load(documentId);
      expect(await h.deliver(message)).toBe('completed');

      const load = vi.spyOn(h.events, 'load').mockResolvedValueOnce(atVersion1);
      expect(await h.deliver(message)).toBe('skipped');
      load.mockRestore();

      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'DocumentProcessed',
      ]);
    });

    it('both resume a crashed attempt at version 2: the second DocumentProcessed loses on (stream, version), skipped', async () => {
      const h = createHarness();
      const { documentId, message } = await submitted(h);
      vi.spyOn(h.rules, 'validate').mockRejectedValueOnce(crash());
      await expect(h.deliver(message)).rejects.toThrow('worker crashed');
      const atVersion2 = await h.events.load(documentId);
      expect(await h.deliver(message)).toBe('completed');

      const load = vi.spyOn(h.events, 'load').mockResolvedValue(atVersion2);
      expect(await h.deliver(message)).toBe('skipped');
      load.mockRestore();

      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'DocumentProcessed',
      ]);
    });
  });

  it('relay re-publishes a message that was already processed: processed exactly once', async () => {
    const h = createHarness();
    const { documentId } = await submitted(h);
    const broker = new RecordingBroker();
    const relay = new OutboxRelay(h.outbox, broker);

    // The broker got the message but the confirm was lost (or the relay crashed before marking
    // the row): the row stays pending and the next run publishes it again.
    broker.loseConfirms = 1;
    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 1 });
    expect(await relay.relayOnce()).toEqual({ published: 1, failed: 0 });
    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 0 });
    const [first, second] = broker.delivered;
    expect(second?.id).toBe(first?.id);

    expect(await h.deliver(first!)).toBe('completed');
    expect(await h.deliver(second!)).toBe('skipped');

    expect(await h.eventTypes(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
  });

  describe('VAT check', () => {
    it(`VAT unavailable: retry via retry.5s, retry.30s, retry.2m, then Failed after ${MAX_PROCESSING_ATTEMPTS} attempts with no further retry`, async () => {
      const h = createHarness();
      h.vat.failNext = Number.POSITIVE_INFINITY;
      const { documentId } = await submitted(h);

      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
        const message = h.lastMessage();
        expect(message.payload).toEqual({ documentId, attempt });
        outcomes.push(await h.deliver(message));
        if (attempt === 1) {
          expect(await h.view(documentId)).toMatchObject({
            status: 'Processing',
            attempts: 1,
            failure: { code: 'VAT_SERVICE_UNAVAILABLE' },
          });
        }
      }

      expect(outcomes).toEqual(['retry-scheduled', 'retry-scheduled', 'retry-scheduled', 'failed']);
      expect(h.outboxMessages().map((m) => m.routingKey)).toEqual([
        'process',
        ...RoutingKeys.retry,
      ]);
      expect(RoutingKeys.retry).toEqual(['retry.5s', 'retry.30s', 'retry.2m']);
      const events = await h.eventsOf(documentId);
      expect(events.map((e) => e.type)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'ProcessingAttemptFailed',
        'ProcessingStarted',
        'ProcessingAttemptFailed',
        'ProcessingStarted',
        'ProcessingAttemptFailed',
        'ProcessingStarted',
        'DocumentProcessingFailed',
      ]);
      expect(
        events.flatMap((e) => (e.type === 'ProcessingAttemptFailed' ? [e.attempt] : [])),
      ).toEqual([1, 2, 3]);
      expect(await h.view(documentId)).toMatchObject({
        status: 'Failed',
        attempts: MAX_PROCESSING_ATTEMPTS,
        failure: { code: 'VAT_SERVICE_UNAVAILABLE' },
      });
    });

    it('VAT unavailable once: the retry completes', async () => {
      const h = createHarness();
      h.vat.failNext = 1;
      const { documentId, message } = await submitted(h);
      expect(await h.deliver(message)).toBe('retry-scheduled');
      expect(await h.deliver(h.lastMessage())).toBe('completed');
      expect(await h.view(documentId)).toMatchObject({ status: 'Completed', attempts: 2 });
      expect((await h.view(documentId))?.failure).toBeUndefined();
    });

    it('VAT invalid: permanent Failed with VAT_NUMBER_INVALID, no retry', async () => {
      const h = createHarness();
      h.vat.invalid.add(customerVat);
      const { documentId, message } = await submitted(h);

      expect(await h.deliver(message)).toBe('failed');

      const view = await h.view(documentId);
      expect(view).toMatchObject({ status: 'Failed', failure: { code: 'VAT_NUMBER_INVALID' } });
      expect(view?.failure?.message).not.toContain(customerVat);
      expect(await h.eventTypes(documentId)).toEqual([
        'DocumentReceived',
        'ProcessingStarted',
        'DocumentProcessingFailed',
      ]);
      expect(h.outboxMessages()).toHaveLength(1);
    });

    it("purchase invoice: checks the supplier's VAT number", async () => {
      const h = createHarness();
      const verify = vi.spyOn(h.vat, 'verify');
      const { message } = await submitted(h, customer);
      expect(await h.deliver(message)).toBe('completed');
      expect(verify.mock.calls).toEqual([[supplierVat]]);
    });

    it("sales invoice: checks the customer's VAT number", async () => {
      const h = createHarness();
      const verify = vi.spyOn(h.vat, 'verify');
      const { message } = await submitted(h, supplier);
      expect(await h.deliver(message)).toBe('completed');
      expect(verify.mock.calls).toEqual([[customerVat]]);
    });

    it('counterparty without a VAT number: completes without a VAT check', async () => {
      const h = createHarness();
      const verify = vi.spyOn(h.vat, 'verify');
      const withoutCustomerVat = fixture
        .toString()
        .replace(
          /<cac:PartyTaxScheme>\s*<cbc:CompanyID>NL009876543B01[\s\S]*?<\/cac:PartyTaxScheme>/,
          '',
        );
      await h.submit({ xml: Buffer.from(withoutCustomerVat) });
      expect(await h.deliver(h.lastMessage())).toBe('completed');
      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('business rules', () => {
    const fatal: RuleViolation = {
      ruleId: 'BR-CO-15',
      flag: 'fatal',
      message: 'Invoice total amount with VAT = total without VAT + total VAT',
      location: '/Invoice',
    };
    const warning: RuleViolation = {
      ruleId: 'PEPPOL-EN16931-R003',
      flag: 'warning',
      message: 'A buyer reference or purchase order reference should be provided',
      location: '/Invoice',
    };

    it('fatal violations: Failed with BUSINESS_RULES_VIOLATED, the violations listed, no VAT check', async () => {
      const h = createHarness();
      h.rules.violations = [fatal, warning];
      const verify = vi.spyOn(h.vat, 'verify');
      const { documentId, message } = await submitted(h);

      expect(await h.deliver(message)).toBe('failed');

      expect((await h.view(documentId))?.failure).toEqual({
        code: 'BUSINESS_RULES_VIOLATED',
        message: '1 EN 16931 / Peppol rule(s) violated',
        violations: [fatal],
      });
      expect(verify).not.toHaveBeenCalled();
      expect(h.outboxMessages()).toHaveLength(1);
    });

    it('warnings alone do not fail: Completed', async () => {
      const h = createHarness();
      h.rules.violations = [warning];
      const { documentId, message } = await submitted(h);
      expect(await h.deliver(message)).toBe('completed');
      expect(await h.view(documentId)).toMatchObject({ status: 'Completed' });
    });
  });
});
