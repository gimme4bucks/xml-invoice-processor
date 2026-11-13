import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export type Scope = 'documents:submit' | 'documents:read' | 'support:read';

/**
 * Which kind of token a scope belongs to (ADR 0017). Organisation scopes need a token with
 * `org_id`; support scopes need one without it. A token is never both.
 */
export const tokenKindFor = (scope: Scope): 'organisation' | 'support' =>
  scope.startsWith('support:') ? 'support' : 'organisation';

/** The calling client, taken from a verified access token. The only source of the organisation. */
export interface Principal {
  /** OAuth client id (`sub`), recorded as the actor in the audit trail. */
  clientId: string;
  organisationId: string;
  /** Peppol participant id of the organisation, e.g. `0106:12345678`. */
  peppolId: string;
  scopes: ReadonlySet<string>;
}

/**
 * A support employee (ADR 0017), from a token issued through Authorization Code + PKCE. It has
 * no organisation: it only reaches the read-only /support endpoints.
 */
export interface SupportPrincipal {
  /** The employee (`sub`), recorded in the audit line of every support request. */
  subject: string;
  scopes: ReadonlySet<string>;
}

export type AuthenticatedRequest = Request & {
  principal?: Principal;
  supportPrincipal?: SupportPrincipal;
};

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

export const CurrentSupportPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SupportPrincipal => {
    const { supportPrincipal } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!supportPrincipal) throw new Error('No support principal on the request');
    return supportPrincipal;
  },
);
