import { applyDecorators, type INestApplication } from '@nestjs/common';
import {
  ApiResponse,
  DocumentBuilder,
  type OpenAPIObject,
  type SchemaObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE } from '../problem-details/problem-details';
import { problemCodes } from '../problem-details/problem-codes';

const catalogue = Object.entries(problemCodes);

const problemDetailsSchema: SchemaObject = {
  type: 'object',
  description: 'RFC 9457 Problem Details. Branch on `code`; `detail` is for humans.',
  required: ['type', 'title', 'status', 'detail', 'code'],
  properties: {
    type: { type: 'string', example: 'urn:xip:problem:document-not-found' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    code: { type: 'string', enum: catalogue.map(([code]) => code) },
    correlationId: { type: 'string', description: 'Echo of `x-correlation-id`.' },
    existingDocumentId: {
      type: 'string',
      format: 'uuid',
      description: 'IDEMPOTENCY_KEY_REUSED and DUPLICATE_DOCUMENT only.',
    },
    reason: {
      type: 'string',
      enum: ['not-well-formed', 'doctype-forbidden', 'unsupported-document-type', 'schema-invalid'],
      description: 'DOCUMENT_REJECTED only.',
    },
    requiredScope: { type: 'string', description: 'INSUFFICIENT_SCOPE only.' },
    errors: {
      type: 'array',
      description: 'DOCUMENT_REJECTED: XSD errors with line/column. INVALID_REQUEST: parameters.',
      items: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          in: { type: 'string', enum: ['path', 'query', 'header'] },
          name: { type: 'string' },
        },
      },
    },
  },
};

const description = [
  'Submit Peppol BIS Billing 3.0 invoices (UBL 2.1 XML) and follow their processing.',
  '',
  'Authenticate with an OAuth2 client-credentials access token (`Authorization: Bearer …`).',
  'Your organisation always comes from the token. Send `x-correlation-id` to trace a request;',
  'it is echoed on every response.',
  '',
  'Errors are `application/problem+json` with a stable `code`:',
  '',
  '| code | status | meaning |',
  '| --- | --- | --- |',
  ...catalogue.map(([code, { status, description }]) => `| ${code} | ${status} | ${description} |`),
].join('\n');

/** Documents the Problem Details responses an operation can return, with their codes. */
export const ApiProblemResponses = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: catalogue
          .filter(([, problem]) => problem.status === status)
          .map(([code]) => code)
          .join(', '),
        content: {
          [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      }),
    ),
  );

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('XML invoice processor')
    .setDescription(description)
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'OAuth2 client-credentials token with documents:submit and/or documents:read.',
    })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ProblemDetails: problemDetailsSchema },
  };
  return document;
}

/** Swagger UI at `/docs`, the raw document at `/openapi.json`. */
export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), {
    jsonDocumentUrl: 'openapi.json',
  });
}
