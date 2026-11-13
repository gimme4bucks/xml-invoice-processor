import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, supportApi } from './support-api';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const session = { accessToken: 'header.payload.signature', expiresAt: NOW + 60_000 };
const document = {
  documentId: '0b7a4c1e-3f4d-4c55-9d0e-2a1f7a1d9c11',
  organisationId: 'org-supplier',
  documentType: 'Invoice',
  direction: 'sales',
  status: 'Completed',
  attempts: 1,
  receivedAt: '2026-11-13T11:59:00.000Z',
  updatedAt: '2026-11-13T11:59:05.000Z',
};

const problem = (status: number, code: string, title: string, headers: HeadersInit = {}) =>
  new Response(
    JSON.stringify({ type: `urn:xip:problem:${code}`, title, status, detail: `${title}.`, code }),
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );

let api: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;
const client = () => supportApi({ apiUrl: 'https://api.test', session, onUnauthorized });
const requested = (call = 0) => {
  const [url, init] = api.mock.calls[call] as [string, RequestInit];
  return { url: new URL(url), headers: new Headers(init.headers) };
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  api = vi.fn(async () => Response.json({ items: [document], nextCursor: 'next-page' }));
  vi.stubGlobal('fetch', api);
  onUnauthorized = vi.fn<() => void>();
});

describe('the support API client', () => {
  it('sends the bearer token to the support endpoints, and nothing else', async () => {
    await client().listDocuments({});

    const { url, headers } = requested();
    expect(`${url.origin}${url.pathname}`).toBe('https://api.test/support/documents');
    expect(headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
    const init = api.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('omit');
  });

  it('builds the list query from the filters, leaving out empty ones', async () => {
    await client().listDocuments({
      organisationId: 'org-supplier',
      status: 'Failed',
      type: 'CreditNote',
    });
    await client().listDocuments({ organisationId: '', status: '', type: '' });

    expect(Object.fromEntries(requested(0).url.searchParams)).toEqual({
      organisationId: 'org-supplier',
      status: 'Failed',
      type: 'CreditNote',
    });
    expect([...requested(1).url.searchParams]).toEqual([]);
  });

  it('returns the page with its cursor and follows the cursor for the next page', async () => {
    const page = await client().listDocuments({ status: 'Failed' });
    await client().listDocuments({ status: 'Failed' }, page.nextCursor);

    expect(page).toEqual({ items: [document], nextCursor: 'next-page' });
    expect(Object.fromEntries(requested(1).url.searchParams)).toEqual({
      status: 'Failed',
      cursor: 'next-page',
    });
  });

  it('reads one document and its history, with the id encoded in the path', async () => {
    api.mockResolvedValueOnce(Response.json(document));
    api.mockResolvedValueOnce(
      Response.json({
        documentId: document.documentId,
        history: [
          { version: 1, type: 'DocumentReceived', occurredAt: document.receivedAt, event: {} },
        ],
      }),
    );

    await expect(client().getDocument(document.documentId)).resolves.toEqual(document);
    await expect(client().getHistory('../documents?x=1')).resolves.toHaveLength(1);

    expect(requested(0).url.pathname).toBe(`/support/documents/${document.documentId}`);
    expect(requested(1).url.pathname).toBe('/support/documents/..%2Fdocuments%3Fx%3D1/history');
  });

  it.each([
    [403, 'INSUFFICIENT_SCOPE', 'Insufficient scope'],
    [404, 'DOCUMENT_NOT_FOUND', 'Document not found'],
    [503, 'SERVICE_UNAVAILABLE', 'Service unavailable'],
  ])(
    'maps a %i Problem Details response to an error with its title and code',
    async (status, code, title) => {
      api.mockResolvedValueOnce(problem(status, code, title));

      const error = await client()
        .getDocument(document.documentId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, code, title, detail: `${title}.` });
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('keeps Retry-After of a 429', async () => {
    api.mockResolvedValueOnce(
      problem(429, 'RATE_LIMITED', 'Too many requests', { 'retry-after': '17' }),
    );

    await expect(client().listDocuments({})).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 17,
    });
  });

  it('maps a response without Problem Details (a proxy error) and a network failure', async () => {
    api.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    api.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(client().listDocuments({})).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_502',
    });
    await expect(client().listDocuments({})).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('signs out on a 401', async () => {
    api.mockResolvedValueOnce(problem(401, 'UNAUTHENTICATED', 'Unauthenticated'));

    await expect(client().listDocuments({})).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('signs out without a request once the token has expired', async () => {
    vi.mocked(Date.now).mockReturnValue(session.expiresAt);

    await expect(client().listDocuments({})).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_EXPIRED',
    });
    expect(api).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
