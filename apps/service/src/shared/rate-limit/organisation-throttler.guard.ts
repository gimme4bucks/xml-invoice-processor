import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/principal';

export interface RateLimitOptions {
  /** Requests per window, per organisation. */
  limit: number;
  windowMs: number;
}

/**
 * One budget per organisation across all routes (fallback: client IP). Runs after the auth guard,
 * so the organisation comes from the verified token. The counters live in this process; several
 * API instances need a shared store (Redis), see ADR 0008. Answers 429 with `Retry-After`.
 */
@Injectable()
export class OrganisationThrottlerGuard extends ThrottlerGuard {
  protected override getTracker({ principal, ip }: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(principal ? `org:${principal.organisationId}` : `ip:${ip}`);
  }

  protected override generateKey(_context: unknown, tracker: string, name: string): string {
    return `${name}:${tracker}`;
  }
}

export const throttlerOptions = ({ limit, windowMs }: RateLimitOptions): ThrottlerModuleOptions => [
  { limit, ttl: windowMs },
];
