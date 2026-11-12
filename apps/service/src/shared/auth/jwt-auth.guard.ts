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
} from './principal';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

const claimsSchema = z.object({
  sub: z.string().min(1),
  org_id: z.string().min(1).max(128),
  peppol_id: z.string().regex(/^\d{4}:\S{1,100}$/),
  scope: z.string(),
});

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
    const principal = await this.authenticate(request.headers.authorization);
    if (!principal.scopes.has(scope)) {
      throw new ApiProblem(
        'INSUFFICIENT_SCOPE',
        `This operation requires the scope "${scope}".`,
        { requiredScope: scope },
        { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
      );
    }
    request.principal = principal;
    return true;
  }

  private async authenticate(header: string | undefined): Promise<Principal> {
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

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      throw unauthenticated(
        'The access token lacks valid org_id/peppol_id/scope.',
        'invalid_token',
      );
    }
    return {
      clientId: claims.data.sub,
      organisationId: claims.data.org_id,
      peppolId: claims.data.peppol_id,
      scopes: new Set(claims.data.scope.split(' ').filter(Boolean)),
    };
  }
}
