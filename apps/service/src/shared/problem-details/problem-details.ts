import { HttpException } from '@nestjs/common';
import {
  DocumentNotFoundError,
  DocumentRejectedError,
  IdempotencyConflictError,
  NotAPartyError,
} from '../../documents/application/errors';
import { DomainError } from '../../documents/domain/errors';
import { type ProblemCode, problemCodes } from './problem-codes';

/** RFC 9457 Problem Details plus our stable `code` and any extension members. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
  [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const problemType = (code: ProblemCode): string =>
  `urn:xip:problem:${code.toLowerCase().replaceAll('_', '-')}`;

/** Thrown by the HTTP layer for a catalogued problem; the global filter renders it. */
export class ApiProblem extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly detail: string,
    readonly extensions: Record<string, unknown> = {},
    /** Response headers that belong to the problem, e.g. `WWW-Authenticate`. */
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = 'ApiProblem';
  }
}

export interface RenderedProblem {
  problem: ProblemDetails;
  headers: Record<string, string>;
  /** True when the error was not anticipated and must be logged with its stack. */
  unexpected: boolean;
}

const problem = (
  code: ProblemCode,
  detail: string,
  extensions: Record<string, unknown> = {},
): ProblemDetails => {
  const { status, title } = problemCodes[code];
  return { type: problemType(code), title, status, detail, code, ...extensions };
};

const internalError = (): RenderedProblem => ({
  problem: problem('INTERNAL_ERROR', 'An unexpected error occurred.'),
  headers: {},
  unexpected: true,
});

/** Status codes that NestJS itself or its libraries throw as HttpException. */
const httpStatusCodes: Partial<Record<number, ProblemCode>> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'INSUFFICIENT_SCOPE',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

const isProblemCode = (code: string): code is ProblemCode => Object.hasOwn(problemCodes, code);

/**
 * Maps any thrown value to Problem Details. Only catalogued errors reveal their message;
 * everything else becomes a 500 without internals (no stack traces, SQL or XML).
 */
export function toProblem(error: unknown): RenderedProblem {
  if (error instanceof ApiProblem) {
    return {
      problem: problem(error.code, error.detail, error.extensions),
      headers: error.headers,
      unexpected: false,
    };
  }
  if (error instanceof DocumentRejectedError) {
    const detail = `The document was rejected: ${error.reason}.`;
    return {
      problem: problem('DOCUMENT_REJECTED', detail, { reason: error.reason, errors: error.errors }),
      headers: {},
      unexpected: false,
    };
  }
  if (error instanceof NotAPartyError) {
    return { problem: problem('NOT_A_PARTY', error.message), headers: {}, unexpected: false };
  }
  if (error instanceof IdempotencyConflictError) {
    const code = error.conflict === 'key-reused' ? 'IDEMPOTENCY_KEY_REUSED' : 'DUPLICATE_DOCUMENT';
    return {
      problem: problem(code, error.message, { existingDocumentId: error.existingDocumentId }),
      headers: {},
      unexpected: false,
    };
  }
  if (error instanceof DocumentNotFoundError) {
    return {
      problem: problem('DOCUMENT_NOT_FOUND', error.message),
      headers: {},
      unexpected: false,
    };
  }
  if (error instanceof DomainError) {
    // Only domain codes in the catalogue are client errors; the others guard invariants that
    // a request can never break (e.g. CORRUPT_STREAM), so seeing one here is our bug.
    return isProblemCode(error.code)
      ? { problem: problem(error.code, error.message), headers: {}, unexpected: false }
      : internalError();
  }
  if (error instanceof HttpException) {
    const code = httpStatusCodes[error.getStatus()];
    if (code) {
      return { problem: problem(code, problemCodes[code].title), headers: {}, unexpected: false };
    }
  }
  return internalError();
}
