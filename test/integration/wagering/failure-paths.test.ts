import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AuditRecorder } from '../../../src/application/audit/audit-recorder';
import {
  IdempotencyConflictError,
  IntegrityViolationError,
  TransientInfrastructureError,
} from '../../../src/application/errors';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction';
import { translateDbError } from '../../../src/infrastructure/persistence/transaction-runner';
import { UuidV7Generator } from '../../../src/infrastructure/system';
import { createTestDatabase, rejectionOf, type TestDatabase } from '../../support/db';
import { FlakyRunner } from '../../support/flaky-runner';
import { assertLedgerInvariant } from '../../support/invariants';
import { RecordingLogger, RecordingMetrics } from '../../support/observability';
import { ManualClock, openOrm, runnerFor } from '../../support/orm';
import { buildServices, httpCtx, wagerCommand } from '../../support/services';

let db: TestDatabase;
let orm: MikroORM;
let services: ReturnType<typeof buildServices>;
let flaky: FlakyRunner;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  services = buildServices(orm);
  flaky = new FlakyRunner(runnerFor(orm));
  const logger = new RecordingLogger();
  const metrics = new RecordingMetrics();
  processWager = new ProcessWagerTransaction(
    flaky,
    new AuditRecorder(flaky, logger, metrics),
    new ManualClock(),
    new UuidV7Generator(),
    logger,
    metrics,
  );
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

describe('dropped database connection', () => {
  test('a code-less "connection terminated" driver error is transient', () => {
    expect(translateDbError(new Error('Connection terminated unexpectedly'))).toBeInstanceOf(TransientInfrastructureError);
    expect(translateDbError(new Error('timeout exceeded when trying to connect'))).toBeInstanceOf(
      TransientInfrastructureError,
    );
  });

  test('an unclassified error is surfaced for retry and never recorded as FAILED', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const cmd = wagerCommand(walletId, playerId);

    flaky.failNext(1, new TypeError('something unexpected'));
    expect(await rejectionOf(processWager.execute(cmd, httpCtx()))).toBeInstanceOf(TypeError);

    const retry = await processWager.execute(cmd, httpCtx());
    expect(retry).toMatchObject({ outcome: 'PROCESSED', idempotentReplay: false, balance: { amount: '75.00' } });
    const failed = await db.sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'FAILED'`, [walletId]);
    expect(failed[0]?.n).toBe(0);
    await assertLedgerInvariant(db, walletId);
  });
});

describe('recording FAILED', () => {
  test('does not turn another payload under the same key into a replay', async () => {
    const other = await wallet('100.00');
    const mine = await wallet('100.00');
    const committed = wagerCommand(other.walletId, other.playerId, {}, 'shared-key');
    await services.processWager.execute(committed, httpCtx());

    const conflicting = wagerCommand(mine.walletId, mine.playerId, { money: { amount: '50.00', currency: 'BRL' } }, 'shared-key');
    flaky.failNext(1, new IntegrityViolationError('integrity: simulated'));

    expect(await rejectionOf(processWager.execute(conflicting, httpCtx()))).toBeInstanceOf(IdempotencyConflictError);
    await assertLedgerInvariant(db);
  });

  test('returns the stored answer when the same payload already committed', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const cmd = wagerCommand(walletId, playerId);
    const first = await services.processWager.execute(cmd, httpCtx());

    flaky.failNext(1, new IntegrityViolationError('integrity: simulated'));
    const again = await processWager.execute(cmd, httpCtx());

    expect(again).toEqual({ ...first, idempotentReplay: true });
  });
});
