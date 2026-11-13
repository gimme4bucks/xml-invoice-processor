import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errors, jwtVerify } from 'jose';
import { z } from 'zod';
import { ApiProblem } from '../problem-details/problem-details';
import { ALLOWED_ALGORITHMS, AUTH_OPTIONS, type AuthOptions } from './auth-options';
import {
  type AuthenticatedRequest,
  type Principal,
  PUBLIC_ROUTE,
  REQUIRED_SCOPE,
  type Scope,
  type SupportPrincipal,
  tokenKindFor,
} from './principal';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

/** A client-credentials token of an organisation (ADR 0008). */
const organisationClaims = z.object({
  sub: z.string().min(1),
  org_id: z.string().min(1).max(128),
  peppol_id: z.string().regex(/^\d{4}:\S{1,100}$/),
  scope: z.string(),
});

/** A support employee's token (ADR 0017): no organisation, so no Peppol id either. */
const supportClaims = z.object({
  sub: z.string().min(1).max(256),
  peppol_id: z.never().optional(),
  scope: z.string(),
});

type Identity =
  { kind: 'organisation'; principal: Principal } | { kind: 'support'; principal: SupportPrincipal };

const unauthenticated = (detail: string, error?: 'invalid_token') =>
  new ApiProblem(
    'UNAUTHENTICATED',
    detail,
    {},
    { 'WWW-Authenticate': error ? `Bearer error="${error}"` : 'Bearer' },
  );

/**
 * Global guard (RFC 6750): 401 without a valid token, 403 without the route's scope. Fails closed:
 * a route that is neither @Public() nor declares a scope is a bug and answers 500.
 *
 * Two kinds of token, kept apart by `org_id` (ADR 0017): an organisation token only reaches the
 * organisation endpoints, a support token only the support endpoints, whatever scopes it claims.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(AUTH_OPTIONS) private readonly options?: AuthOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    const scope = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRED_SCOPE, targets);
    if (!scope) throw new Error(`Route ${context.getHandler().name} declares no scope`);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.authenticate(request.headers.authorization);
    const kind = tokenKindFor(scope);
    if (kind === 'organisation' && identity.kind !== 'organisation') {
      throw new ApiProblem(
        'ORGANISATION_TOKEN_REQUIRED',
        'This operation acts for an organisation: the token must carry org_id.',
      );
    }
    if (kind === 'support' && identity.kind !== 'support') {
      throw new ApiProblem(
        'SUPPORT_TOKEN_REQUIRED',
        'This operation is for support staff: organisation tokens cannot use it.',
      );
    }
    const { principal } = identity;
    if (!principal.scopes.has(scope)) {
      throw new ApiProblem(
        'INSUFFICIENT_SCOPE',
        `This operation requires the scope "${scope}".`,
        { requiredScope: scope },
        { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
      );
    }
    if (identity.kind === 'organisation') request.principal = identity.principal;
    else request.supportPrincipal = identity.principal;
    return true;
  }

  private async authenticate(header: string | undefined): Promise<Identity> {
    if (!header) throw unauthenticated('A bearer token is required.');
    const token = BEARER.exec(header)?.[1];
    if (!token) throw unauthenticated('The Authorization header is not "Bearer <token>".');
    if (!this.options) {
      throw new ApiProblem('AUTH_UNAVAILABLE', 'Token verification is not configured.');
    }

    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.options.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALLOWED_ALGORITHMS,
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      // An IdP we cannot reach is our problem (retry later), not a bad token.
      if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        !(error instanceof errors.JOSEError)
      ) {
        throw new ApiProblem('AUTH_UNAVAILABLE', 'The signing keys could not be fetched.');
      }
      throw unauthenticated('The access token is invalid or expired.', 'invalid_token');
    }

    const scopes = (scope: string) => new Set(scope.split(' ').filter(Boolean));
    if (payload && typeof payload === 'object' && 'org_id' in payload) {
      const claims = organisationClaims.safeParse(payload);
      if (!claims.success) {
        throw unauthenticated(
          'The access token lacks valid org_id/peppol_id/scope.',
          'invalid_token',
        );
      }
      return {
        kind: 'organisation',
        principal: {
          clientId: claims.data.sub,
          organisationId: claims.data.org_id,
          peppolId: claims.data.peppol_id,
          scopes: scopes(claims.data.scope),
        },
      };
    }
    const claims = supportClaims.safeParse(payload);
    if (!claims.success) {
      throw unauthenticated('The access token lacks a valid sub/scope.', 'invalid_token');
    }
    return {
      kind: 'support',
      principal: { subject: claims.data.sub, scopes: scopes(claims.data.scope) },
    };
  }
}
