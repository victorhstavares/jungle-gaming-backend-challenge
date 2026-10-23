import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '../../src/config/config';
import { createHttpApp } from '../../src/interface/http/create-http-app';
import type { TestIssuer } from './tokens';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

export const QUEUES = {
  wager: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  dlq: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  events: 'http://localhost:4566/000000000000/wallet-events.fifo',
};

export function testEnv(databaseUrl: string, issuer: TestIssuer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '20',
    AWS_REGION: 'us-east-1',
    SQS_ENDPOINT: 'http://localhost:4566',
    WAGER_QUEUE_URL: QUEUES.wager,
    WAGER_DLQ_URL: QUEUES.dlq,
    EVENTS_QUEUE_URL: QUEUES.events,
    JWKS_URL: issuer.jwksUrl,
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    APP_ROLES: 'api',
    LOG_LEVEL: 'silent',
    SUPPORTED_CURRENCIES: 'BRL,USD',
    ...extra,
  };
}

export async function startApi(
  databaseUrl: string,
  issuer: TestIssuer,
  extra: Record<string, string> = {},
): Promise<NestFastifyApplication> {
  return createHttpApp(loadConfig(testEnv(databaseUrl, issuer, extra)));
}
