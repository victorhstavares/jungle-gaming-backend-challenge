import pino, { type DestinationStream, type Logger as Pino } from 'pino';
import type { Logger } from '../../application/ports/observability';
import { currentCorrelationId } from './correlation';

/** Credentials and financial payloads never reach the log stream. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'authorization',
  'token',
  'accessToken',
  'clientSecret',
  'password',
  'payload',
  'body',
  '*.authorization',
  '*.token',
  '*.accessToken',
  '*.clientSecret',
  '*.password',
  '*.payload',
  '*.body',
];

export interface LoggerOptions {
  level: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Pino {
  return pino(
    {
      level: options.level,
      base: { service: 'wagering' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      serializers: { err: pino.stdSerializers.err },
      mixin: () => {
        const correlationId = currentCorrelationId();
        return correlationId === undefined ? {} : { correlationId };
      },
    },
    options.destination ?? pino.destination({ sync: false }),
  );
}

export class PinoLogger implements Logger {
  constructor(private readonly pino: Pino) {}

  info(fields: Record<string, unknown>, message: string): void {
    this.pino.info(fields, message);
  }

  warn(fields: Record<string, unknown>, message: string): void {
    this.pino.warn(fields, message);
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.pino.error(fields, message);
  }
}
