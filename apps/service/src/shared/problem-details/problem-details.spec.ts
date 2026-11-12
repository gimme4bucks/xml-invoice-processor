import { describe, expect, it } from 'vitest';
import { PersistenceUnavailableError } from '../../documents/application/ports';
import { DomainError } from '../../documents/domain/errors';
import { SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS, toProblem } from './problem-details';

describe('toProblem', () => {
  it('answers a database outage with 503 and Retry-After, without internals', () => {
    const { problem, headers, unexpected } = toProblem(
      new PersistenceUnavailableError('ECONNREFUSED'),
    );
    expect(problem).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(problem.detail).not.toContain('ECONNREFUSED');
    expect(headers).toEqual({ 'Retry-After': String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS) });
    expect(unexpected).toBe(false);
  });

  it('answers an invoice party without an EndpointID with 422', () => {
    const { problem, unexpected } = toProblem(
      new DomainError('MISSING_ENDPOINT_ID', 'The supplier has no cbc:EndpointID'),
    );
    expect(problem).toMatchObject({ status: 422, code: 'MISSING_ENDPOINT_ID' });
    expect(unexpected).toBe(false);
  });
});
