import { vi } from 'vitest';
import type { HistoryEntry, SupportApi, SupportDocument } from '../api/support-api';

/** A SupportApi whose methods are mocks; each test decides what they answer. */
export function fakeApi() {
  return {
    listDocuments: vi.fn<SupportApi['listDocuments']>(),
    getDocument: vi.fn<SupportApi['getDocument']>(),
    getHistory: vi.fn<SupportApi['getHistory']>(),
  };
}

export const aDocument = (overrides: Partial<SupportDocument> = {}): SupportDocument => ({
  documentId: '0b7a4c1e-3f4d-4c55-9d0e-2a1f7a1d9c11',
  organisationId: 'org-supplier',
  documentType: 'Invoice',
  direction: 'sales',
  status: 'Completed',
  attempts: 1,
  receivedAt: '2026-11-13T11:59:00.000Z',
  updatedAt: '2026-11-13T11:59:05.000Z',
  ...overrides,
});

export const anEntry = (version: number, type: string, event: object = {}): HistoryEntry => ({
  version,
  type,
  occurredAt: `2026-11-13T12:00:0${version}.000Z`,
  event: { type, ...event },
});
