import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService } from '@nestjs/common';
import type { Logger as Pino } from 'pino';
import { AppModule, type AppOverrides } from '../../app.module';
import type { AppConfig } from '../../config/config';
import { correlationIdFrom, runWithCorrelation } from '../../infrastructure/observability/correlation';
import { createLogger } from '../../infrastructure/observability/logger';

const BODY_LIMIT_BYTES = 64 * 1024;

/** Routes Nest's own messages into the same JSON log stream as the application. */
class NestPinoLogger implements LoggerService {
  constructor(private readonly pino: Pino) {}

  log(message: unknown, context?: string): void {
    this.pino.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.pino.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.pino.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.pino.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.pino.trace({ context }, String(message));
  }
}

export async function createHttpApp(config: AppConfig, overrides: AppOverrides = {}): Promise<NestFastifyApplication> {
  const pino = overrides.pino ?? createLogger({ level: config.logLevel });
  const adapter = new FastifyAdapter({ bodyLimit: BODY_LIMIT_BYTES, trustProxy: true });
  const fastify = adapter.getInstance();

  fastify.addHook('onRequest', (request, reply, done) => {
    const header = request.headers['x-correlation-id'];
    request.correlationId = correlationIdFrom(typeof header === 'string' ? header : undefined);
    request.startedAt = performance.now();
    void reply.header('x-correlation-id', request.correlationId);
    runWithCorrelation(request.correlationId, done);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    pino.info(
      {
        correlationId: request.correlationId,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: Math.round((performance.now() - request.startedAt) * 100) / 100,
        clientId: request.principal?.clientId,
      },
      'request completed',
    );
    done();
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config, { pino }), adapter, {
    logger: new NestPinoLogger(pino),
    bufferLogs: false,
  });
  await app.init();
  await fastify.ready();
  return app;
}
