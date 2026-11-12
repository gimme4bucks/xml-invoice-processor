/**
 * `pnpm demo`: walks through the main scenarios against the running stack
 * (`docker compose --profile full up -d --build --wait`) and prints what happens. It only uses the
 * public API and the mock IdP, exactly like a client would, and exits non-zero when an outcome is
 * not the expected one. The outage scenarios (RabbitMQ or Postgres down) are in `pnpm e2e`,
 * because they stop containers.
 *
 * Every run submits fresh invoices (new invoice number, new customer VAT number), because the API
 * refuses a byte-identical file from the same organisation and the stack keeps its data.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = process.env.API_BASE_URL ?? 'http://localhost:3000';
const IDP = process.env.IDP_BASE_URL ?? 'http://localhost:4000';
const INVALID_VAT_NUMBER = (process.env.VIES_INVALID_VAT_NUMBERS ?? 'NL999999999B99').split(',')[0];
const CLIENTS = {
  supplier: { id: 'supplier-client', secret: process.env.DEMO_SUPPLIER_SECRET ?? 'change-me' },
  customer: { id: 'customer-client', secret: process.env.DEMO_CUSTOMER_SECRET ?? 'change-me' },
};

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  headers: Headers;
  body: Json;
}
interface Doc {
  documentId: string;
  status: string;
  direction: string;
  attempts: number;
  failure?: { code: string; message: string; violations?: { ruleId: string }[] };
}
interface HistoryEntry {
  version: number;
  type: string;
  occurredAt: string;
  event: { reason?: { code: string } };
}

// ---------------------------------------------------------------------------------------------
// Output

let failures = 0;
const step = (title: string) => console.log(`\n== ${title}`);
const say = (line: string) => console.log(`   ${line}`);
function check(ok: boolean, what: string): void {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------------------------
// Client

async function token(client: { id: string; secret: string }, scope?: string): Promise<string> {
  const response = await fetch(`${IDP}/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }),
  });
  if (!response.ok) throw new Error(`The mock IdP answered ${response.status} for ${client.id}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** The token's claims (the payload is not secret; the token itself is never printed). */
function claims(jwt: string): Json {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Json;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  jwt: string | undefined,
  init: { xml?: Buffer; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = jwt ? { authorization: `Bearer ${jwt}` } : {};
  if (init.xml) headers['content-type'] = 'application/xml';
  if (init.key) headers['idempotency-key'] = init.key;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: init.xml ? new Uint8Array(init.xml) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Json) : {},
  };
}

const submit = (jwt: string, xml: Buffer, key = randomUUID()) =>
  call('POST', '/documents', jwt, { xml, key });

/** Polls until Completed or Failed (deadline 90 s) and prints every status change. */
async function follow(jwt: string, documentId: string): Promise<Doc> {
  const started = Date.now();
  let last = '';
  for (;;) {
    const doc = (await call('GET', `/documents/${documentId}`, jwt)).body as unknown as Doc;
    const state = `${doc.status} (attempts: ${doc.attempts})`;
    if (state !== last)
      say(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${state}`);
    last = state;
    if (doc.status === 'Completed' || doc.status === 'Failed') return doc;
    if (Date.now() - started > 90_000) throw new Error(`${documentId} is still ${doc.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300)); // poll interval
  }
}

async function printHistory(jwt: string, documentId: string): Promise<HistoryEntry[]> {
  const { history } = (await call('GET', `/documents/${documentId}/history`, jwt)).body as {
    history: HistoryEntry[];
  };
  for (const entry of history) {
    const reason = entry.event.reason ? `  ${entry.event.reason.code}` : '';
    say(`v${entry.version}  ${entry.occurredAt.slice(11, 23)}  ${entry.type}${reason}`);
  }
  return history;
}

// ---------------------------------------------------------------------------------------------
// Example invoices (examples/invoices), made unique for this run

const run = `DEMO-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
let sequence = 0;

function example(name: string, options: { customerVat?: string } = {}): Buffer {
  let xml = readFileSync(new URL(`../../examples/invoices/${name}.xml`, import.meta.url), 'utf8');
  // The first cbc:ID of a UBL invoice is its number (BT-1).
  xml = xml.replace(/<cbc:ID>[^<]*<\/cbc:ID>/, `<cbc:ID>${run}-${++sequence}</cbc:ID>`);
  if (options.customerVat) xml = xml.replace('NL009876543B01', options.customerVat);
  return Buffer.from(xml, 'utf8');
}

const freshVatNumber = () => `NL${randomInt(100_000_000, 999_999_999)}B01`;

// ---------------------------------------------------------------------------------------------
// Scenarios

console.log(`XML invoice processor demo: API ${API}, mock IdP ${IDP}`);

step('1. Tokens from the mock IdP (OAuth2 client credentials)');
const supplier = await token(CLIENTS.supplier);
const customer = await token(CLIENTS.customer);
for (const jwt of [supplier, customer]) {
  const { sub, org_id, peppol_id, scope } = claims(jwt);
  say(
    `${String(sub)}: org_id=${String(org_id)} peppol_id=${String(peppol_id)} scope="${String(scope)}"`,
  );
}

step('2. A sales invoice, from 202 Accepted to Completed');
say('The fake VIES is unavailable for the first two checks of a new VAT number, so the worker');
say('retries through the delay queues before it completes.');
const salesXml = example('valid-sales', { customerVat: freshVatNumber() });
const salesKey = randomUUID();
const accepted = await submit(supplier, salesXml, salesKey);
const salesId = String(accepted.body.documentId);
check(
  accepted.status === 202,
  `POST /documents -> ${accepted.status}, Location ${accepted.headers.get('location')}`,
);
const sales = await follow(supplier, salesId);
check(
  sales.status === 'Completed' && sales.direction === 'sales',
  `${sales.status}, direction ${sales.direction}`,
);
say('Its history: the event stream (the read model is updated in the same transaction)');
const history = await printHistory(supplier, salesId);
check(history.at(-1)?.type === 'DocumentProcessed', 'ends with DocumentProcessed');
const result = (await call('GET', `/documents/${salesId}/result`, supplier)).body as {
  result?: {
    invoice?: { invoiceNumber: string; supplier: Json; customer: Json; lines: unknown[] };
  };
};
const mapped = result.result?.invoice;
check(
  mapped !== undefined,
  `GET /documents/{id}/result: invoice ${mapped?.invoiceNumber}, ${mapped?.lines.length} line(s)`,
);

step('3. Purchase or sales comes from the token: the customer submits the same invoice');
const asCustomer = await submit(customer, salesXml);
const purchase = (await call('GET', `/documents/${String(asCustomer.body.documentId)}`, customer))
  .body;
check(
  asCustomer.status === 202 && purchase.direction === 'purchase',
  `org-customer sees direction ${String(purchase.direction)}`,
);

step('4. A Peppol rule violation (wrong totals): accepted, then Failed in the worker');
const bad = await submit(supplier, example('bad-totals'));
check(
  bad.status === 202,
  `POST -> ${bad.status} (structure is fine; the business rules run asynchronously)`,
);
const badDoc = await follow(supplier, String(bad.body.documentId));
const rules = [...new Set(badDoc.failure?.violations?.map((v) => v.ruleId))].join(', ');
check(badDoc.status === 'Failed' && rules.includes('BR-CO-'), `${badDoc.failure?.code}: ${rules}`);

step('5. A VAT number that does not exist according to VIES: Failed for good, no retry');
const invalid = await submit(supplier, example('valid-sales', { customerVat: INVALID_VAT_NUMBER }));
const invalidDoc = await follow(supplier, String(invalid.body.documentId));
check(
  invalidDoc.failure?.code === 'VAT_NUMBER_INVALID',
  `${invalidDoc.status}: ${invalidDoc.failure?.message}`,
);

step('6. Rejected at intake (synchronous structure checks, 422 Problem Details)');
for (const [name, reason] of [
  ['missing-issue-date', 'schema-invalid'],
  ['credit-note', 'unsupported-document-type'],
  ['doctype-xxe', 'doctype-forbidden'],
] as const) {
  const rejected = await submit(supplier, example(name));
  check(
    rejected.status === 422 && rejected.body.reason === reason,
    `${name}.xml -> ${rejected.status} ${String(rejected.body.code)} (${String(rejected.body.reason)})`,
  );
}

step('7. Idempotency (Idempotency-Key per organisation plus a SHA-256 of the content)');
const replay = await submit(supplier, salesXml, salesKey);
check(
  replay.status === 202 && replay.body.documentId === salesId,
  `same key, same file -> ${replay.status}, same document, Idempotent-Replayed: ${replay.headers.get('idempotent-replayed')}`,
);
const reused = await submit(supplier, example('valid-sales'), salesKey);
check(
  reused.status === 409,
  `same key, other file -> ${reused.status} ${String(reused.body.code)}`,
);
const duplicate = await submit(supplier, salesXml);
check(
  duplicate.status === 409,
  `same file, new key -> ${duplicate.status} ${String(duplicate.body.code)}`,
);

step('8. Authentication and organisation scoping');
const anonymous = await call('GET', '/documents', undefined);
check(anonymous.status === 401, `no token -> ${anonymous.status} ${String(anonymous.body.code)}`);
const readOnly = await submit(
  await token(CLIENTS.supplier, 'documents:read'),
  example('valid-sales'),
);
check(
  readOnly.status === 403,
  `scope documents:read only, POST -> ${readOnly.status} ${String(readOnly.body.code)}`,
);
const foreign = await call('GET', `/documents/${salesId}`, customer);
check(
  foreign.status === 404,
  `org-customer reads org-supplier's document -> ${foreign.status} ${String(foreign.body.code)}`,
);

console.log(
  failures === 0 ? '\nAll scenarios behaved as expected.' : `\n${failures} check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
