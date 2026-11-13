import type { NextFunction, Request, Response } from 'express';

/** The path prefix of the support endpoints (ADR 0017), the only ones a browser app calls. */
export const SUPPORT_PATH = '/support';

/**
 * CORS for the support app (ADR 0017), mounted on /support only when CORS_ORIGINS is set. Exact
 * origins, GET with the Authorization header, no credentials: the app sends a bearer token, never
 * cookies. A preflight from a listed origin is answered here, before authentication (browsers
 * send it without the token); anything else gets no CORS headers, so the browser blocks it.
 */
export function supportCors(origins: readonly string[]) {
  const allowed = new Set(origins);
  return (request: Request, response: Response, next: NextFunction): void => {
    response.vary('Origin');
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) return next();
    response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization');
      response.setHeader('Access-Control-Max-Age', '600');
      response.status(204).end();
      return;
    }
    response.setHeader('Access-Control-Expose-Headers', 'x-correlation-id, Retry-After');
    next();
  };
}
