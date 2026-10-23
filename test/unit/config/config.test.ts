import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/config/config';

const validEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://localhost:4566',
  WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wallet-events.fifo',
  JWKS_URL: 'http://localhost:8080/realms/jungle/protocol/openid-connect/certs',
  AUTH_ISSUER: 'http://localhost:8080/realms/jungle',
  AUTH_AUDIENCE: 'wallet-service',
};

describe('loadConfig', () => {
  test('parses a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);

    expect(config.port).toBe(3000);
    expect(config.roles).toEqual(new Set(['api', 'consumer', 'outbox', 'pending-reference']));
    expect(config.supportedCurrencies).toEqual(new Set(['BRL', 'USD', 'EUR']));
    expect(config.logLevel).toBe('info');
    expect(config.faultInjection).toBeUndefined();
  });

  test('restricts roles when APP_ROLES is set', () => {
    const config = loadConfig({ ...validEnv, APP_ROLES: 'api,outbox' });

    expect(config.roles).toEqual(new Set(['api', 'outbox']));
  });

  test('names the offending variable when the environment is invalid', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...validEnv, APP_ROLES: 'api,cron' })).toThrow(/APP_ROLES/);
    expect(() => loadConfig({ ...validEnv, SUPPORTED_CURRENCIES: 'BRL,real' })).toThrow(/SUPPORTED_CURRENCIES/);
  });

  test('accepts fault injection only in the test environment', () => {
    const testConfig = loadConfig({
      ...validEnv,
      NODE_ENV: 'test',
      FAULT_INJECTION: 'consumer.afterCommitBeforeAck',
    });
    expect(testConfig.faultInjection).toBe('consumer.afterCommitBeforeAck');

    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: 'production', FAULT_INJECTION: 'consumer.afterCommitBeforeAck' }),
    ).toThrow(/FAULT_INJECTION/);
  });
});
