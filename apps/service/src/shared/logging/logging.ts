import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { DestinationStream, LevelWithSilent } from 'pino';
import type { AuthenticatedRequest } from '../auth/principal';

export interface LoggingOptions {
  level: LevelWithSilent;
  /** Where log lines go; stdout by default. Tests pass a stream to inspect the output. */
  destination?: DestinationStream;
}

export const CORRELATION_HEADER = 'x-correlation-id';

/** Accepts the caller's id only when it is short and harmless in a log line. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Uses the caller's `x-correlation-id` or generates one, and echoes it on the response. */
export function correlationId(request: IncomingMessage, response: ServerResponse): string {
  const incoming = request.headers[CORRELATION_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
  response.setHeader(CORRELATION_HEADER, id);
  return id;
}

/**
 * Structured request logging. pino-http never logs bodies; the Authorization header and cookies
 * are redacted. Never add XML content, amounts, VAT numbers or tokens to a log line: IDs only.
 */
export function loggerParams({ level, destination }: LoggingOptions): Params {
  const options = {
    level,
    genReqId: correlationId,
    // Every line logged during a request carries `correlationId` (the full req only on completion).
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'correlationId' },
    customProps: (request: IncomingMessage) => {
      const { principal } = request as AuthenticatedRequest;
      return principal ? { organisationId: principal.organisationId } : {};
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  };
  return { pinoHttp: destination ? [options, destination] : options };
}
