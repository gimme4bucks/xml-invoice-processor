import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../../../../shared/auth/principal';

/** The list filters worth recording; anything else in the query is rejected with a 400 anyway. */
const FILTERS = ['organisationId', 'status', 'type', 'limit', 'cursor'];
const MAX_VALUE_LENGTH = 512;

const value = (raw: unknown) => String(raw).slice(0, MAX_VALUE_LENGTH);

/**
 * Writes one audit line for every support request that passed the guard (ADR 0017): who (`sub`),
 * the endpoint, the document id or the list filters, and the correlation id that every line of
 * the request carries. Logged before the handler runs, so a lookup of a document that does not
 * exist, or one with invalid parameters, is recorded too. Never content: ids and filters only.
 */
@Injectable()
export class SupportAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('SupportAudit');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const route = request.route as { path: string };
    const id: unknown = request.params['id'];
    const query = request.query as Record<string, unknown>;
    const filters = Object.fromEntries(
      FILTERS.filter((name) => query[name] !== undefined).map((name) => [name, value(query[name])]),
    );
    this.logger.log({
      msg: 'support access',
      audit: 'support-access',
      sub: request.supportPrincipal?.subject,
      endpoint: `${request.method} ${route.path}`,
      ...(id === undefined ? { filters } : { documentId: value(id) }),
    });
    return next.handle();
  }
}
