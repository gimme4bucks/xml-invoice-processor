import { createParamDecorator, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { DocumentStatus, DocumentType } from '../../../domain/value-objects';
import { ApiProblem } from '../../../../shared/problem-details/problem-details';

export const documentStatuses = [
  'Received',
  'Processing',
  'Completed',
  'Failed',
] as const satisfies readonly DocumentStatus[];

export const documentTypes = ['Invoice', 'CreditNote'] as const satisfies readonly DocumentType[];

/** Document ids are UUIDs; anything else cannot exist and must not reach the database. */
export const documentIdSchema = z.uuid({ error: 'must be a UUID' });

/** Printable ASCII without spaces, as stored per organisation (ADR 0007). */
export const idempotencyKeySchema = z
  .string({ error: 'is required' })
  .regex(/^[\x21-\x7E]{1,255}$/, { error: 'must be 1-255 printable ASCII characters, no spaces' });

export const listDocumentsQuerySchema = z.strictObject({
  status: z.enum(documentStatuses).optional(),
  type: z.enum(documentTypes).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque, produced by the previous page. */
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9._~:=-]{1,512}$/, { error: 'is not a valid cursor' })
    .optional(),
});

export type ListDocumentsQueryParams = z.infer<typeof listDocumentsQuerySchema>;

/** Support's list (ADR 0017): every organisation, or one, as in the `org_id` claim. */
export const supportListDocumentsQuerySchema = listDocumentsQuerySchema.extend({
  organisationId: z.string().min(1).max(128).optional(),
});

export type SupportListDocumentsQueryParams = z.infer<typeof supportListDocumentsQuerySchema>;

/** One request header by (lower-case) name; unlike @Headers() it accepts validation pipes. */
export const RequestHeader = createParamDecorator(
  (name: string, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest<Request>().headers[name],
);

/** Validates one request parameter (or the whole query) and answers 400 INVALID_REQUEST. */
export class Validate<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly location: 'path' | 'query' | 'header',
    private readonly name?: string,
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ApiProblem('INVALID_REQUEST', 'One or more request parameters are invalid.', {
      errors: result.error.issues.map((issue) => {
        const name = this.name ?? issue.path.join('.');
        return { in: this.location, ...(name ? { name } : {}), message: issue.message };
      }),
    });
  }
}
