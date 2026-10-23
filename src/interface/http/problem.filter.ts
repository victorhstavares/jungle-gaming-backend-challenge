import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../application/ports/observability';
import { TOKENS } from '../../composition/tokens';
import { problemFor } from './status-mapping';

/** Renders every error as RFC 9457 problem+json with a stable `code`; internals never reach the client. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(TOKENS.logger) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = problemFor(exception);

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, correlationId: request.correlationId, method: request.method, url: request.url },
        'request failed',
      );
    }
    if (problem.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(problem.retryAfterSeconds));
    }
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send({
        type: `about:blank#${problem.code}`,
        title: problem.title,
        status: problem.status,
        code: problem.code,
        ...(problem.detail === undefined ? {} : { detail: problem.detail }),
        ...(problem.issues === undefined ? {} : { issues: problem.issues }),
        correlationId: request.correlationId,
      });
  }
}
