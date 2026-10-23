import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessExitFaultInjector } from '../../../src/infrastructure/fault/fault-injector';
import { WagerTransactionConsumer } from '../../../src/interface/messaging/wager-transaction.consumer';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { openOrm } from '../../support/orm';
import { SUPPORTED, buildServices } from '../../support/services';
import { createTestQueues, sqs, wagerMessage, type TestQueues } from '../../support/sqs';

let db: TestDatabase;
let orm: MikroORM;
let queues: TestQueues;
let services: ReturnType<typeof buildServices>;
let consumer: WagerTransactionConsumer;

const MAX_RECEIVES = 3;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  queues = await createTestQueues({ maxReceiveCount: MAX_RECEIVES + 2, visibilityTimeout: 2 });
  services = buildServices(orm);
  consumer = new WagerTransactionConsumer(
    sqs,
    {
      queueUrl: queues.wagerUrl,
      dlqUrl: queues.dlqUrl,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 2,
      maxReceives: MAX_RECEIVES,
      baseBackoffSeconds: 0,
      maxBackoffSeconds: 0,
      shutdownGraceMs: 1_000,
    },
    {
      processWager: services.processWager,
      audit: services.audit,
      supportedCurrencies: SUPPORTED,
      logger: services.logger,
      metrics: services.metrics,
      faults: new ProcessExitFaultInjector(undefined),
      clock: services.clock,
    },
  );
});

afterAll(async () => {
  await queues.destroy();
  await orm.close(true);
  await db.drop();
});

async function wallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const view = await services.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, actor: 'test', correlationId: 'setup' });
  return { walletId: view.id, playerId };
}

function data(walletId: string, playerId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const externalTransactionId = `sqs-${Bun.randomUUIDv7()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const debits = async (walletId: string): Promise<number> =>
  Number((await db.sql(`SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId]))[0]?.n);

const pollUntilEmpty = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    if ((await consumer.pollOnce()) === 0) return;
  }
};

describe('WagerTransactionConsumer', () => {
  test('applies a valid message and acks it after the commit', async () => {
    const { walletId, playerId } = await wallet('100.00');
    await queues.send(wagerMessage(data(walletId, playerId)), walletId);

    await pollUntilEmpty();

    expect(await debits(walletId)).toBe(1);
    expect(await queues.drain(queues.wagerUrl)).toEqual([]);
    const inbox = await db.sql(`SELECT count(*)::int AS n FROM inbox_messages WHERE processed_at IS NOT NULL`);
    expect(Number(inbox[0]?.n)).toBeGreaterThanOrEqual(1);
    await assertLedgerInvariant(db, walletId);
  });

  test('a redelivered message is applied once', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const body = wagerMessage(data(walletId, playerId));
    await queues.send(body, walletId);
    await queues.send(body, walletId);

    await pollUntilEmpty();

    expect(await debits(walletId)).toBe(1);
    expect(services.metrics.count('inbox_duplicates_total')).toBeGreaterThanOrEqual(1);
    await assertLedgerInvariant(db, walletId);
  });

  test('a business rejection is acked, not dead-lettered', async () => {
    const { walletId, playerId } = await wallet('10.00');
    await queues.send(wagerMessage(data(walletId, playerId, { money: { amount: '50.00', currency: 'BRL' } })), walletId);

    await pollUntilEmpty();

    const rows = await db.sql(`SELECT status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [walletId]);
    expect(rows).toEqual([{ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }]);
    expect(await queues.drain(queues.dlqUrl)).toEqual([]);
  });

  test('malformed messages go to the DLQ with a reason and an audit row', async () => {
    const messageId = `msg-bad-${Bun.randomUUIDv7()}`;
    await queues.send('{not json', 'g-bad');
    await queues.send(JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { kind: 'BET' } }), 'g-bad');

    await pollUntilEmpty();

    const parked = await queues.drain(queues.dlqUrl);
    expect(parked.map((m) => m.MessageAttributes?.reason?.StringValue).sort()).toEqual(['INVALID_PAYLOAD', 'INVALID_PAYLOAD']);
    const audited = await db.sql(`SELECT count(*)::int AS n FROM audit_log WHERE source = 'SQS' AND outcome = 'DLQ'`);
    expect(Number(audited[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  test('a message reusing an id with other content is dead-lettered', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const messageId = `msg-reused-${Bun.randomUUIDv7()}`;
    await queues.send(wagerMessage(data(walletId, playerId), messageId), walletId);
    await pollUntilEmpty();
    await queues.send(wagerMessage(data(walletId, playerId), messageId), walletId);
    await pollUntilEmpty();

    const parked = await queues.drain(queues.dlqUrl);
    expect(parked.map((m) => m.MessageAttributes?.reason?.StringValue)).toEqual(['MESSAGE_ID_REUSED']);
    expect(await debits(walletId)).toBe(1);
  });

  test('an unknown wallet is retried and parked once retries run out', async () => {
    await queues.send(wagerMessage(data(Bun.randomUUIDv7(), Bun.randomUUIDv7())), 'g-missing');

    for (let i = 0; i < MAX_RECEIVES + 2; i += 1) {
      await consumer.pollOnce();
      await Bun.sleep(300);
    }

    const parked = await queues.drain(queues.dlqUrl, 2);
    expect(parked.map((m) => m.MessageAttributes?.reason?.StringValue)).toEqual(['WALLET_NOT_FOUND']);
    expect(services.metrics.count('sqs_retries_total', { reason: 'WALLET_NOT_FOUND' })).toBeGreaterThanOrEqual(1);
  });

  test('a crash after the commit and before the ack does not apply the bet twice', async () => {
    const { walletId, playerId } = await wallet('100.00');
    await queues.send(wagerMessage(data(walletId, playerId)), walletId);

    const child = Bun.spawn(['bun', 'test/support/consumer-child.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: db.url,
        WAGER_QUEUE_URL: queues.wagerUrl,
        WAGER_DLQ_URL: queues.dlqUrl,
        FAULT_INJECTION: 'consumer.afterCommitBeforeAck',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(137);
    expect(await debits(walletId)).toBe(1);

    await Bun.sleep(2_500);
    await pollUntilEmpty();

    expect(await debits(walletId)).toBe(1);
    expect(services.metrics.count('inbox_duplicates_total')).toBeGreaterThanOrEqual(1);
    expect(await queues.drain(queues.wagerUrl)).toEqual([]);
    await assertLedgerInvariant(db, walletId);
  });
});
