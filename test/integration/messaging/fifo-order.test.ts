import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../../src/application/errors';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction';
import { ProcessExitFaultInjector } from '../../../src/infrastructure/fault/fault-injector';
import { UuidV7Generator } from '../../../src/infrastructure/system';
import { WagerTransactionConsumer } from '../../../src/interface/messaging/wager-transaction.consumer';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { FlakyRunner } from '../../support/flaky-runner';
import { openOrm } from '../../support/orm';
import { SUPPORTED, buildServices } from '../../support/services';
import { createTestQueues, sqs, wagerMessage, type TestQueues } from '../../support/sqs';

let db: TestDatabase;
let orm: MikroORM;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  queues = await createTestQueues({ visibilityTimeout: 2 });
});

afterAll(async () => {
  await queues.destroy();
  await orm.close(true);
  await db.drop();
});

test('a retried message keeps its place: later messages of its group wait for it', async () => {
  const services = buildServices(orm);
  const flaky = new FlakyRunner(services.runner);
  const processWager = new ProcessWagerTransaction(flaky, services.audit, services.clock, new UuidV7Generator(), services.logger, services.metrics);
  const consumer = new WagerTransactionConsumer(
    sqs,
    { queueUrl: queues.wagerUrl, dlqUrl: queues.dlqUrl, waitTimeSeconds: 1, visibilityTimeoutSeconds: 5, maxReceives: 5, baseBackoffSeconds: 0, maxBackoffSeconds: 0, shutdownGraceMs: 1_000 },
    { processWager, audit: services.audit, supportedCurrencies: SUPPORTED, logger: services.logger, metrics: services.metrics, faults: new ProcessExitFaultInjector(undefined), clock: services.clock },
  );
  const playerId = Bun.randomUUIDv7();
  const wallet = await services.openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' }, actor: 't', correlationId: 'c' });
  const bet = (id: string) => ({
    providerId: 'provider-a', externalTransactionId: id, idempotencyKey: `provider-a:${id}`, playerId, walletId: wallet.id,
    roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '80.00', currency: 'BRL' },
  });
  await queues.send(wagerMessage(bet('first')), wallet.id);
  await queues.send(wagerMessage(bet('second')), wallet.id);

  flaky.failNext(1, new TransientInfrastructureError('lock wait', { reason: 'lock_timeout' }));
  for (let i = 0; i < 6; i += 1) await consumer.pollOnce();

  const rows = await db.sql(
    `SELECT external_transaction_id AS ext, status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' ORDER BY ext`,
    [wallet.id],
  );
  expect(rows).toEqual([
    { ext: 'first', status: 'PROCESSED', failure_code: null },
    { ext: 'second', status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
  ]);
});
