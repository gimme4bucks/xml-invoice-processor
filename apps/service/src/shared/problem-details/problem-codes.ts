/**
 * The stable error code catalogue (ADR 0012). Clients branch on `code`, never on `detail`, so a
 * code is part of the API contract: add new codes, never rename or reuse one. The catalogue is
 * published in the OpenAPI description.
 */
export const problemCodes = {
  INVALID_REQUEST: {
    status: 400,
    title: 'Invalid request',
    description: 'A path, query or header parameter is missing or invalid; see `errors`.',
  },
  UNAUTHENTICATED: {
    status: 401,
    title: 'Unauthenticated',
    description: 'The bearer token is missing, malformed, expired or not issued for this API.',
  },
  INSUFFICIENT_SCOPE: {
    status: 403,
    title: 'Insufficient scope',
    description: 'The token is valid but lacks the scope this operation requires.',
  },
  ORGANISATION_TOKEN_REQUIRED: {
    status: 403,
    title: 'Organisation token required',
    description:
      'The token carries no `org_id` (a support token): it cannot use the organisation endpoints.',
  },
  SUPPORT_TOKEN_REQUIRED: {
    status: 403,
    title: 'Support token required',
    description:
      'The support endpoints need a support token (`support:read`, no `org_id`); organisation tokens cannot use them.',
  },
  DOCUMENT_NOT_FOUND: {
    status: 404,
    title: 'Document not found',
    description: 'No document with this id exists for your organisation.',
  },
  NOT_FOUND: {
    status: 404,
    title: 'Not found',
    description: 'No such route.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    title: 'Idempotency-Key reused',
    description:
      'The Idempotency-Key was already used for a document with different content; see `existingDocumentId`.',
  },
  DUPLICATE_DOCUMENT: {
    status: 409,
    title: 'Duplicate document',
    description:
      'This exact file was already submitted under another Idempotency-Key; see `existingDocumentId`.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Payload too large',
    description: 'The request body exceeds the maximum document size.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Unsupported media type',
    description: 'Send the document as `Content-Type: application/xml` without a Content-Encoding.',
  },
  UNSUPPORTED_CHARSET: {
    status: 415,
    title: 'Unsupported charset',
    description: 'Only UTF-8 is accepted (Content-Type charset, XML declaration and bytes).',
  },
  DOCUMENT_REJECTED: {
    status: 422,
    title: 'Document rejected',
    description:
      'The document failed the structural checks (well-formedness, DOCTYPE ban, document type, UBL 2.1 XSD); see `reason` and `errors`.',
  },
  NOT_A_PARTY: {
    status: 422,
    title: 'Not a party to the invoice',
    description:
      "Your organisation's Peppol id is neither the supplier's nor the customer's EndpointID.",
  },
  // DomainError codes surface as-is when listed here; unlisted ones are invariants (500).
  INVALID_PEPPOL_ID: {
    status: 422,
    title: 'Invalid Peppol participant id',
    description:
      'An EndpointID in the invoice is not a valid Peppol participant id (`0000:value`).',
  },
  MISSING_ENDPOINT_ID: {
    status: 422,
    title: 'Missing EndpointID',
    description:
      'The supplier or customer has no `cbc:EndpointID` with a `schemeID` (Peppol participant id).',
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Too many requests',
    description: 'Rate limit for your organisation exceeded; retry after `Retry-After` seconds.',
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Internal error',
    description: 'Something went wrong on our side. Quote the correlation id when reporting it.',
  },
  AUTH_UNAVAILABLE: {
    status: 503,
    title: 'Authentication unavailable',
    description: "The identity provider's signing keys could not be fetched; retry later.",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    title: 'Service unavailable',
    description:
      'A backing service (the database) is temporarily unavailable. The document may or may not have been stored: retry after `Retry-After` seconds with the same Idempotency-Key and body, which is always safe.',
  },
} as const satisfies Record<string, { status: number; title: string; description: string }>;

export type ProblemCode = keyof typeof problemCodes;
