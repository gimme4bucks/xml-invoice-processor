import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/support-api';
import { DocumentList } from './DocumentList';
import { aDocument, fakeApi } from './fake-api';

const first = aDocument({ documentId: 'doc-1', organisationId: 'org-supplier', status: 'Failed' });
const second = aDocument({
  documentId: 'doc-2',
  organisationId: 'org-customer',
  documentType: 'CreditNote',
});
const third = aDocument({ documentId: 'doc-3', organisationId: 'org-customer' });

let api: ReturnType<typeof fakeApi>;
let opened: string[];
const show = () => render(<DocumentList api={api} onOpen={(id) => opened.push(id)} />);
const rows = () => screen.getAllByRole('row').slice(1);

beforeEach(() => {
  api = fakeApi();
  opened = [];
  api.listDocuments.mockResolvedValue({ items: [first, second], nextCursor: 'cursor-2' });
});

describe('the document list', () => {
  it('shows the documents of every organisation, in the order the API sends (newest first)', async () => {
    show();

    expect(await screen.findByText('doc-1')).toBeTruthy();
    expect(api.listDocuments).toHaveBeenCalledWith(
      { organisationId: '', status: '', type: '' },
      undefined,
    );
    expect(rows().map((row) => within(row).getByRole('button').textContent)).toEqual([
      'doc-1',
      'doc-2',
    ]);
    expect(within(rows()[0]!).getByText('org-supplier')).toBeTruthy();
    expect(within(rows()[0]!).getByText('Failed')).toBeTruthy();
    expect(within(rows()[1]!).getByText('org-customer')).toBeTruthy();
    expect(within(rows()[1]!).getByText('CreditNote')).toBeTruthy();
  });

  it('filters by organisation, status and type', async () => {
    show();
    await screen.findByText('doc-1');

    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'org-customer' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Failed' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'CreditNote' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findAllByText('doc-1');
    expect(api.listDocuments).toHaveBeenLastCalledWith(
      { organisationId: 'org-customer', status: 'Failed', type: 'CreditNote' },
      undefined,
    );
  });

  it('loads more with the cursor and the same filters, until there is no next page', async () => {
    show();
    await screen.findByText('doc-1');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('doc-1');
    api.listDocuments.mockResolvedValueOnce({ items: [third] });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('doc-3')).toBeTruthy();
    expect(api.listDocuments).toHaveBeenLastCalledWith(
      { organisationId: '', status: 'Failed', type: '' },
      'cursor-2',
    );
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('opens a document', async () => {
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'doc-2' }));

    expect(opened).toEqual(['doc-2']);
  });

  it('shows text that looks like HTML as text', async () => {
    const html = '<img src=x onerror="alert(1)">';
    api.listDocuments.mockResolvedValueOnce({ items: [aDocument({ organisationId: html })] });

    const { container } = show();

    expect(await screen.findByText(html)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows a Problem Details error with its title and code', async () => {
    api.listDocuments.mockRejectedValueOnce(
      new ApiError(429, 'RATE_LIMITED', 'Too many requests', 'Slow down.', 17),
    );

    show();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many requests');
    expect(alert.textContent).toContain('RATE_LIMITED');
    expect(alert.textContent).toContain('17 seconds');
  });
});
