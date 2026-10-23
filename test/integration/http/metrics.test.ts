import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { startApi } from '../../support/http';
import { startTestIssuer, type TestIssuer } from '../../support/tokens';

let db: TestDatabase;
let issuer: TestIssuer;
let app: NestFastifyApplication;

beforeAll(async () => {
  db = await createTestDatabase();
  issuer = await startTestIssuer();
  app = await startApi(db.url, issuer);
});

afterAll(async () => {
  await app.close();
  await issuer.stop();
  await db.drop();
});

test('the README metrics move with real traffic', async () => {
  const operator = await issuer.operator();
  const provider = await issuer.provider('provider-a');
  const playerId = Bun.randomUUIDv7();
  const wallet = await app.inject({
    method: 'POST',
    url: '/wallets',
    headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  const walletId = (JSON.parse(wallet.body) as { id: string }).id;
  const body = {
    providerId: 'provider-a',
    externalTransactionId: 'metrics-1',
    playerId,
    walletId,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
  const submit = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/wagering/transactions',
      headers: { authorization: `Bearer ${provider}`, 'content-type': 'application/json', 'idempotency-key': 'provider-a:metrics-1' },
      payload: JSON.stringify(payload),
    });

  expect((await submit(body)).statusCode).toBe(201);
  expect((await submit(body)).statusCode).toBe(201);
  expect((await submit({ ...body, gameId: 'other' })).statusCode).toBe(409);
  await app.inject({ method: 'GET', url: '/wallets/x' });

  const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
  expect(text).toContain('idempotent_replays_total 1');
  expect(text).toContain('idempotency_conflicts_total 1');
  expect(text).toMatch(/wallet_lock_wait_seconds_count \d+/);
  expect(text).toMatch(/wager_processing_seconds_count\{source="HTTP"\} 3/);
  expect(text).toContain('auth_failures_total{reason="missing_token"} 1');
  for (const name of ['sqs_dlq_total', 'sqs_retries_total', 'outbox_lag_seconds', 'wallet_lock_timeouts_total', 'inbox_duplicates_total']) {
    expect(text).toContain(`# TYPE ${name}`);
  }
});
