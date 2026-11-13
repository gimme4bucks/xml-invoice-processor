import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DocumentEventType, FailureReason } from '../../../domain/document-events';
import type { DocumentStatus, DocumentType, InvoiceDirection } from '../../../domain/value-objects';
import type { DocumentView } from '../../../application/ports';
import type { HistoryEntry } from '../../../application/queries/document-queries';
import { documentStatuses, documentTypes } from './request-validation';

// Response shapes of the public API. Views are mapped field by field, so a new internal field
// (like the stream version or organisation id) never leaks by accident.

export class SubmittedDocumentDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ enum: ['Received'] }) status!: 'Received';
}

export class DocumentDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ enum: documentTypes }) documentType!: DocumentType;
  @ApiProperty({ enum: ['purchase', 'sales'], description: "From your organisation's view" })
  direction!: InvoiceDirection;
  @ApiProperty({ enum: documentStatuses }) status!: DocumentStatus;
  @ApiProperty({ description: 'Processing attempts so far' }) attempts!: number;
  @ApiPropertyOptional({
    description: 'Why the document Failed (or the last attempt failed): `code`, `message`, rules',
  })
  failure?: FailureReason;
  @ApiProperty() receivedAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() completedAt?: string;
}

export class DocumentListDto {
  @ApiProperty({ type: [DocumentDto] }) items!: DocumentDto[];
  @ApiPropertyOptional({ description: 'Pass as `cursor` for the next page; absent on the last' })
  nextCursor?: string;
}

export class DocumentResultDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ enum: documentStatuses }) status!: DocumentStatus;
  @ApiPropertyOptional({ description: 'The processing result; only when status is Completed' })
  result?: unknown;
}

export class HistoryEntryDto {
  @ApiProperty() version!: number;
  @ApiProperty() type!: DocumentEventType;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) event!: Record<string, unknown>;
}

export class DocumentHistoryDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ type: [HistoryEntryDto] }) history!: HistoryEntryDto[];
}

export function toDocumentDto(view: DocumentView): DocumentDto {
  return {
    documentId: view.documentId,
    documentType: view.documentType,
    direction: view.direction,
    status: view.status,
    attempts: view.attempts,
    ...(view.failure ? { failure: view.failure } : {}),
    receivedAt: view.receivedAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    ...(view.completedAt ? { completedAt: view.completedAt.toISOString() } : {}),
  };
}

export function toHistoryEntryDto(entry: HistoryEntry): HistoryEntryDto {
  return {
    version: entry.version,
    type: entry.type,
    occurredAt: entry.occurredAt.toISOString(),
    event: { ...entry.event },
  };
}
