import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletNotFoundError } from '../../../src/application/errors';
import { createTestDatabase, rejectionOf, type TestDatabase } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { openOrm } from '../../support/orm';
import { buildServices, httpCtx, wagerCommand } from '../../support/services';

let db: TestDatabase;
let orm: MikroORM;
let services: ReturnType<typeof buildServices>;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  services = buildServices(orm);
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

async function wallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const view = await services.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    actor: 'backoffice',
    correlationId: 'setup',
  });
  return { walletId: view.id, playerId };
}

const rows = (sql: string, params: unknown[]) => db.sql(sql, params);
const countOf = async (sql: string, params: unknown[]): Promise<number> => Number((await rows(sql, params))[0]?.n);

describe('BET', () => {
  test('debits, posts both legs, enqueues events and audits in one commit', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const result = await services.processWager.execute(wagerCommand(walletId, playerId), httpCtx());

    expect(result).toMatchObject({
      outcome: 'PROCESSED',
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const txId = result.transactionId;
    expect(await countOf('SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1', [txId])).toBe(2);
    const events = await rows('SELECT event_type FROM outbox_messages WHERE payload->>$2 IS NOT NULL AND (aggregate_id = $1 OR aggregate_id = $3) ORDER BY occurred_at, event_type', [txId, 'eventId', walletId]);
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionProcessed');
    expect(events.map((e) => e.event_type)).toContain('WalletBalanceChanged');
    expect(await countOf(`SELECT count(*)::int AS n FROM audit_log WHERE transaction_id = $1 AND outcome = 'PROCESSED'`, [txId])).toBe(1);
    await assertLedgerInvariant(db, walletId);
  });

  test('rejects insufficient funds without touching the balance', async () => {
    const { walletId, playerId } = await wallet('10.00');
    const result = await services.processWager.execute(
      wagerCommand(walletId, playerId, { money: { amount: '10.01', currency: 'BRL' } }),
      httpCtx(),
    );

    expect(result).toMatchObject({ outcome: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await countOf('SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1', [result.transactionId])).toBe(0);
    await assertLedgerInvariant(db, walletId);
  });
});

describe('idempotency', () => {
  test('an identical replay returns the original result, including the balance seen then', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const cmd = wagerCommand(walletId, playerId);
    const first = await services.processWager.execute(cmd, httpCtx());
    await services.processWager.execute(wagerCommand(walletId, playerId), httpCtx());

    const replay = await services.processWager.execute(cmd, httpCtx());

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(await countOf(`SELECT count(*)::int AS n FROM audit_log WHERE transaction_id = $1 AND outcome = 'REPLAY'`, [first.transactionId])).toBe(1);
    await assertLedgerInvariant(db, walletId);
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const cmd = wagerCommand(walletId, playerId);
    await services.processWager.execute(cmd, httpCtx());

    const conflicting = wagerCommand(walletId, playerId, { externalTransactionId: cmd.externalTransactionId, gameId: 'other-game' });
    const correlationId = `corr-conflict-${Bun.randomUUIDv7()}`;
    expect(await rejectionOf(services.processWager.execute(conflicting, httpCtx(correlationId)))).toBeInstanceOf(IdempotencyConflictError);

    expect(await countOf('SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1', [walletId])).toBe(2);
    expect(await countOf(`SELECT count(*)::int AS n FROM audit_log WHERE correlation_id = $1 AND outcome = 'IDEMPOTENCY_CONFLICT'`, [correlationId])).toBe(1);
  });

  test('the same external id under another idempotency key is a conflict', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const cmd = wagerCommand(walletId, playerId);
    await services.processWager.execute(cmd, httpCtx());

    const otherKey = wagerCommand(walletId, playerId, { externalTransactionId: cmd.externalTransactionId }, 'another-key');
    expect(await rejectionOf(services.processWager.execute(otherKey, httpCtx()))).toBeInstanceOf(IdempotencyConflictError);
    await assertLedgerInvariant(db, walletId);
  });

  test('a redelivered message is recognised by the inbox and applied once', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const cmd = wagerCommand(walletId, playerId);
    const inbox = { consumerName: 'wager-transactions-consumer', messageId: `msg-${Bun.randomUUIDv7()}`, payloadHash: cmd.payloadHash };
    const sqsCtx = { source: 'SQS' as const, actor: 'sqs', correlationId: inbox.messageId, inbox };

    expect((await services.processWager.execute(cmd, sqsCtx)).outcome).toBe('PROCESSED');
    expect((await services.processWager.execute(cmd, sqsCtx)).outcome).toBe('DUPLICATE_MESSAGE');
    expect(await countOf(`SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).toBe(1);
    await assertLedgerInvariant(db, walletId);
  });
});

describe('LOSS', () => {
  test('is processed without ledger entries or balance event', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const result = await services.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
      httpCtx(),
    );

    expect(result).toMatchObject({ outcome: 'PROCESSED', balance: { amount: '100.00' } });
    expect(await countOf('SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1', [result.transactionId])).toBe(0);
    expect(await countOf(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionProcessed'`, [result.transactionId])).toBe(1);
  });
});

describe('references', () => {
  test('a refund that arrives first waits, then settles once the bet is processed', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerCommand(walletId, playerId);
    const refund = wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await services.processWager.execute(refund, httpCtx());
    expect(pending).toMatchObject({ outcome: 'PENDING_REFERENCE', status: 'PENDING_REFERENCE' });
    expect(await countOf(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionPendingReference'`, [pending.transactionId])).toBe(1);

    await services.processWager.execute(bet, httpCtx());
    const due = await rows('SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = $1', [pending.transactionId]);
    expect(due[0]?.due).toBe(true);

    const settled = await services.processWager.reprocessPending(pending.transactionId ?? '', { source: 'WORKER', actor: 'worker', correlationId: 'retry' });
    expect(settled).toMatchObject({ outcome: 'PROCESSED', balance: { amount: '100.00' } });
    await assertLedgerInvariant(db, walletId);
  });

  test('rolling back a win the player already spent is rejected with a reversal code', async () => {
    const { walletId, playerId } = await wallet('0.00');
    const win = wagerCommand(walletId, playerId, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await services.processWager.execute(win, httpCtx());
    await services.processWager.execute(wagerCommand(walletId, playerId, { money: { amount: '45.00', currency: 'BRL' } }), httpCtx());

    const rollback = await services.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'ROLLBACK', money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: win.externalTransactionId }),
      httpCtx(),
    );

    expect(rollback).toMatchObject({ outcome: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
    await assertLedgerInvariant(db, walletId);
  });
});

describe('failures', () => {
  test('an unknown wallet is reported and audited, nothing is persisted', async () => {
    const walletId = Bun.randomUUIDv7();
    const correlationId = `corr-missing-${walletId}`;
    expect(await rejectionOf(services.processWager.execute(wagerCommand(walletId, Bun.randomUUIDv7()), httpCtx(correlationId)))).toBeInstanceOf(WalletNotFoundError);
    expect(await countOf(`SELECT count(*)::int AS n FROM audit_log WHERE correlation_id = $1 AND outcome = 'NOT_FOUND'`, [correlationId])).toBe(1);
  });

  test('a credit that would overflow the balance column becomes an audited FAILED transaction', async () => {
    const { walletId, playerId } = await wallet('0.00');
    const maxWin = { kind: 'WIN', money: { amount: '999999999999999.99', currency: 'BRL' } };
    for (let i = 0; i < 92; i += 1) {
      await services.processWager.execute(wagerCommand(walletId, playerId, maxWin), httpCtx());
    }
    const before = await rows('SELECT balance_minor::text AS b, version FROM wallets WHERE id = $1', [walletId]);

    const result = await services.processWager.execute(wagerCommand(walletId, playerId, maxWin), httpCtx());

    expect(result).toMatchObject({ outcome: 'FAILED', status: 'FAILED', failureCode: 'PROCESSING_FAILED' });
    expect(await rows('SELECT balance_minor::text AS b, version FROM wallets WHERE id = $1', [walletId])).toEqual(before);
    expect(await countOf(`SELECT count(*)::int AS n FROM audit_log WHERE transaction_id = $1 AND outcome = 'FAILED'`, [result.transactionId])).toBe(1);
    await assertLedgerInvariant(db, walletId);
  });
});
