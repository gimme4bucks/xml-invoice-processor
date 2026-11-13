import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  SubmitDocumentCommand,
  type SubmitDocumentResult,
} from '../../../application/commands/submit-document';
import type { DocumentPage, DocumentView } from '../../../application/ports';
import {
  GetDocumentHistoryQuery,
  GetDocumentQuery,
  GetDocumentResultQuery,
  type HistoryEntry,
  ListDocumentsQuery,
} from '../../../application/queries/document-queries';
import { CurrentPrincipal, type Principal, RequireScope } from '../../../../shared/auth/principal';
import { ApiProblemResponses } from '../../../../shared/http/openapi';
import {
  DocumentDto,
  DocumentHistoryDto,
  DocumentListDto,
  DocumentResultDto,
  SubmittedDocumentDto,
  toDocumentDto,
  toHistoryEntryDto,
} from './document.dto';
import {
  documentIdSchema,
  documentStatuses,
  documentTypes,
  idempotencyKeySchema,
  type ListDocumentsQueryParams,
  listDocumentsQuerySchema,
  RequestHeader,
  Validate,
} from './request-validation';
import { MAX_DOCUMENT_BYTES, readXmlBody } from './xml-body';

const documentId = new Validate(documentIdSchema, 'path', 'id');

/**
 * The public documents API. The organisation always comes from the token (CurrentPrincipal),
 * never from the URL or body; another organisation's document is simply not found.
 */
@ApiTags('documents')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 429, 500)
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Post()
  @HttpCode(202)
  @RequireScope('documents:submit')
  @ApiOperation({
    summary: 'Submit a Peppol BIS 3.0 invoice',
    description: `Raw UBL 2.1 Invoice XML, UTF-8, at most ${MAX_DOCUMENT_BYTES} bytes. Structure is validated now; business rules run asynchronously.`,
  })
  @ApiConsumes('application/xml')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique per document; a retry with the same key and body is answered again.',
  })
  @ApiAcceptedResponse({
    type: SubmittedDocumentDto,
    description:
      'Accepted. `Location` points to the document; a replay sets `Idempotent-Replayed: true`.',
  })
  @ApiProblemResponses(400, 409, 413, 415, 422)
  async submit(
    @CurrentPrincipal() principal: Principal,
    @RequestHeader(
      'idempotency-key',
      new Validate(idempotencyKeySchema, 'header', 'Idempotency-Key'),
    )
    idempotencyKey: string,
    @Req() request: Request & { id: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmittedDocumentDto> {
    const xml = await readXmlBody(request);
    const result: SubmitDocumentResult = await this.commands.execute(
      new SubmitDocumentCommand({
        organisationId: principal.organisationId,
        peppolId: principal.peppolId,
        clientId: principal.clientId,
        idempotencyKey,
        xml,
        correlationId: request.id,
      }),
    );
    response.setHeader('Location', `/documents/${result.documentId}`);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return { documentId: result.documentId, status: 'Received' };
  }

  @Get()
  @RequireScope('documents:read')
  @ApiOperation({ summary: "List your organisation's documents, newest first" })
  @ApiQuery({ name: 'status', required: false, enum: documentStatuses })
  @ApiQuery({ name: 'type', required: false, enum: documentTypes, description: 'Document type' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'cursor', required: false, description: '`nextCursor` of the previous page' })
  @ApiOkResponse({ type: DocumentListDto })
  @ApiProblemResponses(400)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new Validate(listDocumentsQuerySchema, 'query')) query: ListDocumentsQueryParams,
  ): Promise<DocumentListDto> {
    const { type, ...options } = query;
    const page: DocumentPage = await this.queries.execute(
      new ListDocumentsQuery(principal.organisationId, { ...options, documentType: type }),
    );
    return {
      items: page.items.map(toDocumentDto),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  @Get(':id')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'Status of one document' })
  @ApiOkResponse({ type: DocumentDto })
  @ApiProblemResponses(400, 404)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentId) id: string,
  ): Promise<DocumentDto> {
    const view: DocumentView = await this.queries.execute(
      new GetDocumentQuery(principal.organisationId, id),
    );
    return toDocumentDto(view);
  }

  @Get(':id/result')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'Processing result; `result` is present only when Completed' })
  @ApiOkResponse({ type: DocumentResultDto })
  @ApiProblemResponses(400, 404)
  async result(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentId) id: string,
  ): Promise<DocumentResultDto> {
    const { status, result }: Omit<DocumentResultDto, 'documentId'> = await this.queries.execute(
      new GetDocumentResultQuery(principal.organisationId, id),
    );
    return { documentId: id, status, ...(result === undefined ? {} : { result }) };
  }

  @Get(':id/history')
  @RequireScope('documents:read')
  @ApiOperation({ summary: "The document's event stream (audit trail)" })
  @ApiOkResponse({ type: DocumentHistoryDto })
  @ApiProblemResponses(400, 404)
  async history(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentId) id: string,
  ): Promise<DocumentHistoryDto> {
    const history: HistoryEntry[] = await this.queries.execute(
      new GetDocumentHistoryQuery(principal.organisationId, id),
    );
    return { documentId: id, history: history.map(toHistoryEntryDto) };
  }
}
