import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { RetryPendingReferences } from '../../../src/application/pending/retry-pending-references';
import { PENDING_REFERENCE_MAX_ATTEMPTS } from '../../../src/application/wagering/pending-reference-policy';
import { createTestDatabase, type TestDatabase } from '../../support/db';
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

const worker = (): RetryPendingReferences =>
  new RetryPendingReferences(services.runner, services.processWager, services.clock, services.logger, services.metrics, {
    batchSize: 50,
    leaseMs: 30_000,
  });

async function wallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const view = await services.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, actor: 't', correlationId: 'c' });
  return { walletId: view.id, playerId };
}

const statusOf = async (id: string | undefined): Promise<Record<string, unknown> | undefined> =>
  (await db.sql('SELECT status, failure_code, attempts FROM wager_transactions WHERE id = $1', [id]))[0];

describe('RetryPendingReferences', () => {
  test('settles a refund once its bet has been processed', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerCommand(walletId, playerId);
    const refund = await services.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
      httpCtx(),
    );
    await services.processWager.execute(bet, httpCtx());

    expect(await worker().execute()).toBeGreaterThanOrEqual(1);

    expect(await statusOf(refund.transactionId)).toMatchObject({ status: 'PROCESSED' });
    const [balance] = await db.sql('SELECT balance_minor::text AS b FROM wallets WHERE id = $1', [walletId]);
    expect(balance?.b).toBe('10000');
    await assertLedgerInvariant(db, walletId);
  });

  test('gives up with REFERENCE_NOT_FOUND after the last attempt, with an event and an audit trail', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const rollback = await services.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: 'never-arrives' }),
      httpCtx(),
    );

    for (let i = 0; i < PENDING_REFERENCE_MAX_ATTEMPTS + 2; i += 1) {
      services.clock.advance(301_000);
      await worker().execute();
    }

    expect(await statusOf(rollback.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      attempts: PENDING_REFERENCE_MAX_ATTEMPTS,
    });
    const events = await db.sql(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY occurred_at`, [rollback.transactionId]);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    const retries = await db.sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE transaction_id = $1 AND operation = 'RETRY_PENDING_REFERENCE'`,
      [rollback.transactionId],
    );
    expect(Number(retries[0]?.n)).toBe(PENDING_REFERENCE_MAX_ATTEMPTS);
  });

  test('two workers never settle the same pending transaction twice', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerCommand(walletId, playerId);
    const refund = await services.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
      httpCtx(),
    );
    await services.processWager.execute(bet, httpCtx());

    await Promise.all([worker().execute(), worker().execute(), worker().execute()]);

    const transitions = await db.sql(
      `SELECT count(*)::int AS n FROM wager_transaction_status_history WHERE transaction_id = $1 AND to_status = 'PROCESSED'`,
      [refund.transactionId],
    );
    expect(transitions[0]?.n).toBe(1);
    await assertLedgerInvariant(db, walletId);
  });
});
