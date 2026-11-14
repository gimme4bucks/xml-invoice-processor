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
import { SUPPORT_PATH } from './support-cors';

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
  'The `/support` endpoints are for support staff only: a token from the Authorization Code +',
  'PKCE flow with scope `support:read` and no `org_id`. They are read-only across organisations,',
  'never return the XML or the processing result, and every request is audited (ADR 0017).',
  'Organisation tokens cannot use them, and support tokens cannot use the organisation endpoints.',
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

export interface OpenApiOptions {
  /** The IdP's token endpoint; set, the document declares a client-credentials flow. */
  oauthTokenUrl?: string;
}

/** The security scheme of the Swagger UI's Authorize button for client credentials. */
const CLIENT_CREDENTIALS = 'client-credentials';

/**
 * Offers the client-credentials login on every operation that takes the bearer token, except the
 * support endpoints: their tokens come from Authorization Code + PKCE (ADR 0017). Each entry of
 * `security` is an alternative, so the plain bearer token keeps working.
 */
function offerClientCredentials(document: OpenAPIObject): void {
  for (const [path, item] of Object.entries(document.paths)) {
    if (path === SUPPORT_PATH || path.startsWith(`${SUPPORT_PATH}/`)) continue;
    for (const operation of Object.values(item) as { security?: Record<string, string[]>[] }[]) {
      if (operation?.security?.some((requirement) => 'bearer' in requirement)) {
        operation.security.push({ [CLIENT_CREDENTIALS]: [] });
      }
    }
  }
}

export function createOpenApiDocument(
  app: INestApplication,
  options: OpenApiOptions = {},
): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('XML invoice processor')
    .setDescription(description)
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Organisation: a client-credentials token with documents:submit and/or documents:read. Support: an Authorization Code + PKCE token with support:read and no org_id.',
    });
  if (options.oauthTokenUrl) {
    builder.addOAuth2(
      {
        type: 'oauth2',
        description:
          'Organisation login for trying the API here: the client id and secret of a demo client. Swagger UI fetches the token from the IdP.',
        flows: {
          clientCredentials: {
            tokenUrl: options.oauthTokenUrl,
            scopes: {
              'documents:submit': 'Submit documents',
              'documents:read': "Read your organisation's documents",
            },
          },
        },
      },
      CLIENT_CREDENTIALS,
    );
  }
  const document = SwaggerModule.createDocument(app, builder.build());
  if (options.oauthTokenUrl) offerClientCredentials(document);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ProblemDetails: problemDetailsSchema },
  };
  return document;
}

/** Swagger UI at `/docs`, the raw document at `/openapi.json`. */
export function setupOpenApi(app: INestApplication, options: OpenApiOptions = {}): void {
  SwaggerModule.setup('docs', app, createOpenApiDocument(app, options), {
    jsonDocumentUrl: 'openapi.json',
  });
}
