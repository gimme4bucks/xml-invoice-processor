import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type {
  DocumentDto,
  DocumentHistoryDto,
  DocumentResultDto,
  HistoryEntryDto,
  SubmittedDocumentDto,
} from '../../../src/documents/adapters/inbound/http/document.dto';
import type { ProblemDetails } from '../../../src/shared/problem-details/problem-details';
import { type PeppolFixture, peppolFixture } from '../../fixtures/peppol';

/**
 * Helpers for the end-to-end tests. They talk to the running compose stack
 * (`docker compose --profile full up -d --build --wait`) over HTTPS through the edge, with tokens
 * from the mock IdP, and stop or freeze its containers for the outage scenarios. `pnpm e2e` trusts
 * the edge's root certificate (NODE_EXTRA_CA_CERTS); nothing here disables verification. Nothing
 * here sleeps for a fixed time: every wait polls a condition until a deadline.
 */
export const stack = {
  apiUrl: process.env.API_BASE_URL ?? 'https://localhost:3443',
  idpUrl: process.env.IDP_BASE_URL ?? 'https://localhost:4443',
  /** The compose defaults (docker-compose.yml): the fake VIES fails twice per new VAT number. */
  viesFailuresPerNumber: Number(process.env.VIES_UNAVAILABLE_TIMES_PER_NUMBER ?? 2),
  invalidVatNumber: (process.env.VIES_INVALID_VAT_NUMBERS ?? 'NL999999999B99').split(',')[0]!,
  /** TTLs of the retry delay queues in the stack. */
  retryDelaysMs: (process.env.RETRY_DELAYS_MS ?? '1000,2000,5000').split(',').map(Number),
};

/** The two demo clients of the compose stack: supplier and customer of the fixture invoices. */
export const clients = {
  supplier: { id: 'supplier-client', secret: 'change-me' },
  customer: { id: 'customer-client', secret: 'change-me' },
} as const;

export async function accessToken(
  client: { id: string; secret: string },
  scope?: string,
): Promise<string> {
  const response = await fetch(`${stack.idpUrl}/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }),
  });
  if (!response.ok) throw new Error(`Token request failed with ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON: a DTO on success, Problem Details on an error; read it with `expectBody`. */
  body: unknown;
}

/** Asserts the status code (showing the body when it differs) and returns the body as `T`. */
export function expectBody<T = ProblemDetails>(response: ApiResponse, status: number): T {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body as T;
}

/** A client of the API with one organisation's token (or none). */
export class Api {
  constructor(private readonly token?: string) {}

  static async as(client: { id: string; secret: string }, scope?: string): Promise<Api> {
    return new Api(await accessToken(client, scope));
  }

  submit(xml: Buffer, idempotencyKey: string = randomUUID()): Promise<ApiResponse> {
    return this.request('POST', '/documents', {
      body: new Uint8Array(xml),
      headers: { 'content-type': 'application/xml', 'idempotency-key': idempotencyKey },
    });
  }

  /** Submits and expects 202; returns the new document's id. */
  async accepted(xml: Buffer, idempotencyKey?: string): Promise<string> {
    return expectBody<SubmittedDocumentDto>(await this.submit(xml, idempotencyKey), 202).documentId;
  }

  get(pathname: string): Promise<ApiResponse> {
    return this.request('GET', pathname);
  }

  async document(documentId: string): Promise<DocumentDto> {
    return expectBody<DocumentDto>(await this.get(`/documents/${documentId}`), 200);
  }

  async result(documentId: string): Promise<DocumentResultDto> {
    return expectBody<DocumentResultDto>(await this.get(`/documents/${documentId}/result`), 200);
  }

  async history(documentId: string): Promise<HistoryEntryDto[]> {
    const response = await this.get(`/documents/${documentId}/history`);
    return expectBody<DocumentHistoryDto>(response, 200).history;
  }

  /** Polls the document until `done` holds, failing with its last state at the deadline. */
  async waitFor(
    documentId: string,
    done: (document: DocumentDto) => boolean,
    timeoutMs = 60_000,
  ): Promise<DocumentDto> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status, body } = await this.get(`/documents/${documentId}`);
      if (status === 200 && done(body as DocumentDto)) return body as DocumentDto;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${documentId}: ${status} ${JSON.stringify(body)}`);
      }
      await pause(250);
    }
  }

  /** Waits until the document is Completed or Failed. */
  waitForFinal(documentId: string, timeoutMs?: number): Promise<DocumentDto> {
    return this.waitFor(
      documentId,
      (d) => d.status === 'Completed' || d.status === 'Failed',
      timeoutMs,
    );
  }

  /**
   * Asserts that the document was processed exactly once, however often its messages were
   * delivered: gapless versions, one ProcessingStarted per attempt, one DocumentProcessed.
   */
  async expectProcessedOnce(documentId: string): Promise<void> {
    const document = await this.document(documentId);
    const history = await this.history(documentId);
    const count = (type: string) => history.filter((entry) => entry.type === type).length;
    expect(history.map((entry) => entry.version)).toEqual(history.map((_, i) => i + 1));
    expect(count('ProcessingStarted')).toBe(document.attempts);
    expect(count('DocumentProcessed')).toBe(1);
  }

  private async request(
    method: string,
    pathname: string,
    init: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse> {
    const response = await fetch(`${stack.apiUrl}${pathname}`, {
      method,
      body: init.body,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
  }
}

/** Interval between two polls; never used as "wait long enough for X to happen". */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A VAT number the worker's fake VIES has not seen yet, so it fails exactly N times first. */
export const freshVatNumber = (): string => `NL${randomInt(100_000_000, 999_999_999)}B01`;

/**
 * A fixture made unique, because the API rejects a byte-identical file from the same organisation
 * (409) and the stack keeps its data between runs. `customerVat` replaces the customer's VAT
 * number: on a sales invoice that is the counterparty the worker checks with VIES.
 */
export function invoice(
  fixture: PeppolFixture = 'valid-sales',
  options: { customerVat?: string } = {},
): Buffer {
  let xml = peppolFixture(fixture)
    .toString('utf8')
    .replace(/<cbc:ID>INV-2026-0101<\/cbc:ID>/, `<cbc:ID>E2E-${randomUUID()}</cbc:ID>`);
  if (options.customerVat) xml = xml.replace('NL009876543B01', options.customerVat);
  return Buffer.from(xml, 'utf8');
}

const repoRoot = path.resolve(__dirname, '../../../../..');

/** Runs `docker compose <args>` for this repository's stack (project xml-invoice-processor). */
export async function compose(...args: string[]): Promise<void> {
  await promisify(execFile)('docker', ['compose', ...args], { cwd: repoRoot });
}
