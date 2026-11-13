import { Controller, Get, Param, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { DocumentPage, DocumentView } from '../../../application/ports';
import type { HistoryEntry } from '../../../application/queries/document-queries';
import {
  SupportGetDocumentHistoryQuery,
  SupportGetDocumentQuery,
  SupportListDocumentsQuery,
} from '../../../application/queries/support-queries';
import { RequireScope } from '../../../../shared/auth/principal';
import { ApiProblemResponses } from '../../../../shared/http/openapi';
import {
  DocumentHistoryDto,
  SupportDocumentDto,
  SupportDocumentListDto,
  toHistoryEntryDto,
  toSupportDocumentDto,
} from './document.dto';
import {
  documentIdSchema,
  documentStatuses,
  documentTypes,
  type SupportListDocumentsQueryParams,
  supportListDocumentsQuerySchema,
  Validate,
} from './request-validation';

const documentId = new Validate(documentIdSchema, 'path', 'id');

/**
 * Read-only support endpoints across organisations (ADR 0017), for support tokens with
 * `support:read` only; the guard keeps organisation tokens out. Metadata, status, failure reasons
 * and history; there is deliberately no endpoint for the XML or the processing result.
 */
@ApiTags('support')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 429, 500)
@Controller('support/documents')
export class SupportDocumentsController {
  constructor(private readonly queries: QueryBus) {}

  @Get()
  @RequireScope('support:read')
  @ApiOperation({ summary: 'Support: documents of every organisation, newest first' })
  @ApiQuery({ name: 'organisationId', required: false, description: 'Only this organisation' })
  @ApiQuery({ name: 'status', required: false, enum: documentStatuses })
  @ApiQuery({ name: 'type', required: false, enum: documentTypes, description: 'Document type' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'cursor', required: false, description: '`nextCursor` of the previous page' })
  @ApiOkResponse({ type: SupportDocumentListDto })
  @ApiProblemResponses(400)
  async list(
    @Query(new Validate(supportListDocumentsQuerySchema, 'query'))
    query: SupportListDocumentsQueryParams,
  ): Promise<SupportDocumentListDto> {
    const { type, ...options } = query;
    const page: DocumentPage = await this.queries.execute(
      new SupportListDocumentsQuery({ ...options, documentType: type }),
    );
    return {
      items: page.items.map(toSupportDocumentDto),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  @Get(':id')
  @RequireScope('support:read')
  @ApiOperation({ summary: "Support: any organisation's document, without content" })
  @ApiOkResponse({ type: SupportDocumentDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('id', documentId) id: string): Promise<SupportDocumentDto> {
    const view: DocumentView = await this.queries.execute(new SupportGetDocumentQuery(id));
    return toSupportDocumentDto(view);
  }

  @Get(':id/history')
  @RequireScope('support:read')
  @ApiOperation({ summary: "Support: any organisation's document event stream" })
  @ApiOkResponse({ type: DocumentHistoryDto })
  @ApiProblemResponses(400, 404)
  async history(@Param('id', documentId) id: string): Promise<DocumentHistoryDto> {
    const history: HistoryEntry[] = await this.queries.execute(
      new SupportGetDocumentHistoryQuery(id),
    );
    return { documentId: id, history: history.map(toHistoryEntryDto) };
  }
}
