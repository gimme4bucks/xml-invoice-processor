import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/principal';

export interface RateLimitOptions {
  /** Requests per window, per organisation. */
  limit: number;
  windowMs: number;
}

/**
 * One budget per organisation across all routes; a support token, which has no organisation, gets
 * one per employee (`sub`, ADR 0017); fallback: client IP. Runs after the auth guard, so both come
 * from the verified token. The counters live in this process; several API instances need a shared
 * store (Redis), see ADR 0008. Answers 429 with `Retry-After`.
 */
@Injectable()
export class OrganisationThrottlerGuard extends ThrottlerGuard {
  protected override getTracker({
    principal,
    supportPrincipal,
    ip,
  }: AuthenticatedRequest): Promise<string> {
    if (principal) return Promise.resolve(`org:${principal.organisationId}`);
    if (supportPrincipal) return Promise.resolve(`support:${supportPrincipal.subject}`);
    return Promise.resolve(`ip:${ip}`);
  }

  protected override generateKey(_context: unknown, tracker: string, name: string): string {
    return `${name}:${tracker}`;
  }
}

export const throttlerOptions = ({ limit, windowMs }: RateLimitOptions): ThrottlerModuleOptions => [
  { limit, ttl: windowMs },
];
