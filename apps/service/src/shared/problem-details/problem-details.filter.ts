import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem-details';

/** Renders every error as `application/problem+json` (RFC 9457) with a stable `code`. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const { problem, headers, unexpected } = toProblem(exception);

    // Log the error type and stack only; messages of unexpected errors stay out of the response.
    if (unexpected) this.logger.error(exception);
    if (response.headersSent) return;

    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response
      .status(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        JSON.stringify(
          typeof request.id === 'string' ? { ...problem, correlationId: request.id } : problem,
        ),
      );
  }
}
