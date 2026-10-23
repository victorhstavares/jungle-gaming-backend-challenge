import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { startApi } from '../../support/http';
import { assertLedgerInvariant } from '../../support/invariants';
import { startTestIssuer, type TestIssuer } from '../../support/tokens';

let db: TestDatabase;
let issuer: TestIssuer;
let app: NestFastifyApplication;
let operator: string;
let providerA: string;
let providerB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  issuer = await startTestIssuer();
  app = await startApi(db.url, issuer);
  operator = await issuer.operator();
  providerA = await issuer.provider('provider-a');
  providerB = await issuer.provider('provider-b');
});

afterAll(async () => {
  await app.close();
  await issuer.stop();
  await db.drop();
});

type Json = Record<string, unknown>;

async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<{ status: number; body: Json; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined && options.rawBody === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.rawBody !== undefined ? { payload: options.rawBody } : options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  return { status: res.statusCode, body: res.body.length > 0 ? (JSON.parse(res.body) as Json) : {}, headers: res.headers };
}

async function createWallet(amount = '1000.00'): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const res = await call('POST', '/wallets', {
    token: operator,
    body: { playerId, initialBalance: { amount, currency: 'BRL' } },
  });
  expect(res.status).toBe(201);
  return { walletId: String(res.body.id), playerId };
}

let seq = 0;
function wager(walletId: string, playerId: string, overrides: Json = {}): Json {
  seq += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `http-${String(seq)}-${Bun.randomUUIDv7().slice(-8)}`,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (body: Json, token = providerA, key = `${String(body.providerId)}:${String(body.externalTransactionId)}`) =>
  call('POST', '/wagering/transactions', { token, body, headers: { 'idempotency-key': key } });

describe('wallets', () => {
  test('POST /wallets returns the README shape', async () => {
    const playerId = Bun.randomUUIDv7();
    const res = await call('POST', '/wallets', { token: operator, body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: res.body.id, playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const { playerId } = await createWallet();
    const res = await call('POST', '/wallets', { token: operator, body: { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  test('GET /wallets/:id, ledger and reconciliation', async () => {
    const { walletId, playerId } = await createWallet();
    await submit(wager(walletId, playerId));

    const wallet = await call('GET', `/wallets/${walletId}`, { token: providerA });
    expect(wallet.body).toMatchObject({ balance: { amount: '975.00', currency: 'BRL' }, version: 2 });

    const ledger = await call('GET', `/wallets/${walletId}/ledger?limit=1`, { token: operator });
    expect(ledger.status).toBe(200);
    expect((ledger.body.items as unknown[]).length).toBe(1);
    const next = await call('GET', `/wallets/${walletId}/ledger?limit=1&cursor=${String(ledger.body.nextCursor)}`, { token: operator });
    expect((next.body.items as Json[])[0]?.direction).toBe('DEBIT');

    const rec = await call('POST', `/wallets/${walletId}/reconciliation`, { token: operator });
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ walletId, consistent: true, checkedEntries: 2, difference: { amount: '0.00', currency: 'BRL' } });
  });

  test('a malformed wallet id or cursor is a 400, not a 500', async () => {
    expect((await call('GET', '/wallets/not-a-uuid', { token: operator })).status).toBe(400);
    const { walletId } = await createWallet();
    const res = await call('GET', `/wallets/${walletId}/ledger?cursor=@@@`, { token: operator });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  test('unknown wallet is a 404', async () => {
    const res = await call('GET', `/wallets/${Bun.randomUUIDv7()}`, { token: operator });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('wagering', () => {
  test('a BET returns 201 with the README body, and a replay returns the same answer', async () => {
    const { walletId, playerId } = await createWallet();
    const body = wager(walletId, playerId);

    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await submit(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await assertLedgerInvariant(db, walletId);
  });

  test('the same key with another payload is a 409', async () => {
    const { walletId, playerId } = await createWallet();
    const body = wager(walletId, playerId);
    await submit(body);

    const res = await submit({ ...body, gameId: 'another-game' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('a business rejection is a 422 carrying the failure code', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const res = await submit(wager(walletId, playerId, { money: { amount: '10.01', currency: 'BRL' } }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
  });

  test('a reversal waiting for its reference is a 202', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await submit(wager(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test.each([
    ['missing Idempotency-Key', {}, undefined, 'MISSING_IDEMPOTENCY_KEY'],
    ['amount with one decimal', { money: { amount: '25.5', currency: 'BRL' } }, 'k', 'INVALID_MONEY'],
    ['10 KB round id', { roundId: 'r'.repeat(10_240) }, 'k', 'INVALID_PAYLOAD'],
    ['OPENING kind', { kind: 'OPENING' }, 'k', 'OPENING_NOT_ALLOWED'],
    ['unknown field', { bonus: true }, 'k', 'INVALID_PAYLOAD'],
  ])('%s is a 400 with code %s', async (_label, overrides, key, code) => {
    const { walletId, playerId } = await createWallet();
    const res = await call('POST', '/wagering/transactions', {
      token: providerA,
      body: wager(walletId, playerId, overrides),
      headers: key === undefined ? {} : { 'idempotency-key': `${key}-${Bun.randomUUIDv7()}` },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  test('a body above 64 KB is a 413 problem, and malformed JSON is a 400', async () => {
    const big = await call('POST', '/wagering/transactions', {
      token: providerA,
      rawBody: JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) }),
      headers: { 'idempotency-key': 'big' },
    });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');

    const broken = await call('POST', '/wagering/transactions', { token: providerA, rawBody: '{"kind": ', headers: { 'idempotency-key': 'broken' } });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe('INVALID_PAYLOAD');
  });

  test('transactions are readable by id and by provider external id', async () => {
    const { walletId, playerId } = await createWallet();
    const body = wager(walletId, playerId);
    const created = await submit(body);

    const byId = await call('GET', `/wagering/transactions/${String(created.body.transactionId)}`, { token: providerA });
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ externalTransactionId: body.externalTransactionId, status: 'PROCESSED' });

    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`, { token: providerA });
    expect(byExternal.body).toEqual(byId.body);

    expect((await call('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`, { token: providerA })).status).toBe(404);
  });
});

describe('authentication and authorization', () => {
  test('no token or a bad token is a 401', async () => {
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(401);
    const expired = await issuer.sign({ azp: 'provider-a', provider_id: 'provider-a', realm_access: { roles: ['provider'] } }, { expiresIn: '-1m' });
    const res = await call('GET', `/wallets/${Bun.randomUUIDv7()}`, { token: expired });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('a provider cannot submit for another provider', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await submit(wager(walletId, playerId, { providerId: 'provider-b' }), providerA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROVIDER_MISMATCH');
  });

  test("a provider cannot see another provider's transaction, by id or by path", async () => {
    const { walletId, playerId } = await createWallet();
    const body = wager(walletId, playerId);
    const created = await submit(body);

    expect((await call('GET', `/wagering/transactions/${String(created.body.transactionId)}`, { token: providerB })).status).toBe(404);
    const byPath = await call('GET', `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`, { token: providerB });
    expect(byPath.status).toBe(403);
  });

  test('operator-only routes refuse providers', async () => {
    const res = await call('POST', '/wallets', { token: providerA, body: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.00', currency: 'BRL' } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('health and metrics are open', async () => {
    expect((await call('GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('wager_transactions_total');
  });

  test('responses carry the correlation id', async () => {
    const res = await call('GET', '/health/live', { headers: { 'x-correlation-id': 'corr-http-1' } });
    expect(res.headers['x-correlation-id']).toBe('corr-http-1');
  });
});

describe('readiness', () => {
  test('reports SQS down without failing liveness', async () => {
    const broken = await startApi(db.url, issuer, { SQS_ENDPOINT: 'http://localhost:1', WAGER_QUEUE_URL: 'http://localhost:1/000000000000/x.fifo' });
    try {
      const ready = await broken.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(JSON.parse(ready.body)).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect((await broken.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    } finally {
      await broken.close();
    }
  });
});
