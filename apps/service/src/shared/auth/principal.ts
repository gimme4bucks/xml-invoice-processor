import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export type Scope = 'documents:submit' | 'documents:read';

/** The calling client, taken from a verified access token. The only source of the organisation. */
export interface Principal {
  /** OAuth client id (`sub`), recorded as the actor in the audit trail. */
  clientId: string;
  organisationId: string;
  /** Peppol participant id of the organisation, e.g. `0106:12345678`. */
  peppolId: string;
  scopes: ReadonlySet<string>;
}

export type AuthenticatedRequest = Request & { principal?: Principal };

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_SCOPE = 'auth:required-scope';

/** No token needed (health check). Every other route must declare a scope. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export const RequireScope = (scope: Scope) => SetMetadata(REQUIRED_SCOPE, scope);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const { principal } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!principal) throw new Error('No principal on the request: is the route public?');
    return principal;
  },
);
