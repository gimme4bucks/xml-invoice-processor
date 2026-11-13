import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/support-api';
import { DocumentDetail } from './DocumentDetail';
import { aDocument, anEntry, fakeApi } from './fake-api';

const failed = aDocument({
  documentId: 'doc-failed',
  organisationId: 'org-customer',
  status: 'Failed',
  attempts: 1,
  failure: {
    code: 'BUSINESS_RULES_VIOLATED',
    message: 'The invoice violates 2 fatal rules.',
    violations: [
      {
        ruleId: 'BR-CO-15',
        flag: 'fatal',
        message: 'Total with VAT is wrong',
        location: '/Invoice[1]',
      },
      {
        ruleId: 'PEPPOL-EN16931-R001',
        flag: 'fatal',
        message: 'No business process',
        location: '/Invoice[1]/cbc:ProfileID',
      },
    ],
  },
});

let api: ReturnType<typeof fakeApi>;
const onBack = vi.fn();
const show = (documentId = 'doc-failed') =>
  render(<DocumentDetail api={api} documentId={documentId} onBack={onBack} />);

beforeEach(() => {
  api = fakeApi();
  api.getDocument.mockResolvedValue(failed);
  // Not in order: the timeline orders by version itself.
  api.getHistory.mockResolvedValue([
    anEntry(3, 'DocumentProcessingFailed', { reason: failed.failure }),
    anEntry(1, 'DocumentReceived'),
    anEntry(2, 'ProcessingStarted'),
  ]);
});

describe('the document detail', () => {
  it('shows the metadata and the status', async () => {
    show();

    const metadata = await screen.findByRole('region', { name: 'Document' });
    expect(api.getDocument).toHaveBeenCalledWith('doc-failed');
    expect(within(metadata).getByText('doc-failed')).toBeTruthy();
    expect(within(metadata).getByText('org-customer')).toBeTruthy();
    expect(within(metadata).getByText('Failed')).toBeTruthy();
    expect(within(metadata).getByText('Invoice')).toBeTruthy();
  });

  it("shows a failed document's reasons, with every violated rule", async () => {
    show();

    const failure = await screen.findByRole('region', { name: 'Failure' });
    expect(within(failure).getByText('BUSINESS_RULES_VIOLATED')).toBeTruthy();
    expect(within(failure).getByText('The invoice violates 2 fatal rules.')).toBeTruthy();
    expect(within(failure).getByText('BR-CO-15')).toBeTruthy();
    expect(within(failure).getByText('No business process')).toBeTruthy();
    expect(within(failure).getByText('/Invoice[1]/cbc:ProfileID')).toBeTruthy();
  });

  it('has no failure section for a document without one', async () => {
    api.getDocument.mockResolvedValueOnce(aDocument({ documentId: 'doc-ok' }));

    show('doc-ok');

    await screen.findByRole('region', { name: 'Document' });
    expect(screen.queryByRole('region', { name: 'Failure' })).toBeNull();
  });

  it('shows the history as a timeline, oldest event first', async () => {
    show();

    const history = await screen.findByRole('region', { name: 'History' });
    const events = within(history)
      .getAllByRole('listitem')
      .map((item) => within(item).getByRole('heading').textContent);
    expect(events).toEqual(['DocumentReceived', 'ProcessingStarted', 'DocumentProcessingFailed']);
  });

  it('shows text that looks like HTML as text', async () => {
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    api.getDocument.mockResolvedValueOnce({ ...failed, failure: { code: 'X', message: html } });
    api.getHistory.mockResolvedValueOnce([anEntry(1, 'DocumentReceived', { note: html })]);

    const { container } = show();

    const failure = await screen.findByRole('region', { name: 'Failure' });
    expect(within(failure).getByText(html)).toBeTruthy();
    expect(container.querySelector('img, script')).toBeNull();
  });

  it.each([
    [404, 'DOCUMENT_NOT_FOUND', 'Document not found'],
    [403, 'INSUFFICIENT_SCOPE', 'Insufficient scope'],
    [503, 'SERVICE_UNAVAILABLE', 'Service unavailable'],
  ])('shows a %i problem with its title and code', async (status, code, title) => {
    api.getDocument.mockRejectedValueOnce(new ApiError(status, code, title));

    show();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(code);
  });

  it('goes back to the list', async () => {
    show();

    fireEvent.click(await screen.findByRole('button', { name: /back to the list/i }));

    expect(onBack).toHaveBeenCalledOnce();
  });
});
