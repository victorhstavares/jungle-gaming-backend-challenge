import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startApp } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { testEnv } from '../support/http';
import { assertLedgerInvariant } from '../support/invariants';
import { openOrm } from '../support/orm';
import { buildServices } from '../support/services';
import { createTestQueues, wagerMessage, type TestQueues } from '../support/sqs';
import { startTestIssuer, type TestIssuer } from '../support/tokens';

let db: TestDatabase;
let orm: MikroORM;
let queues: TestQueues;
let issuer: TestIssuer;
let services: ReturnType<typeof buildServices>;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  queues = await createTestQueues({ visibilityTimeout: 5 });
  issuer = await startTestIssuer();
  services = buildServices(orm);
});

afterAll(async () => {
  await queues.destroy();
  await issuer.stop();
  await orm.close(true);
  await db.drop();
});

const env = (): Record<string, string> =>
  testEnv(db.url, issuer, {
    APP_ROLES: 'api,consumer,outbox,pending-reference',
    WAGER_QUEUE_URL: queues.wagerUrl,
    WAGER_DLQ_URL: queues.dlqUrl,
    EVENTS_QUEUE_URL: queues.eventsUrl,
    LOG_LEVEL: 'info',
  });

function bet(walletId: string, playerId: string): string {
  const externalTransactionId = `life-${Bun.randomUUIDv7()}`;
  return wagerMessage({
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  });
}

const debits = async (walletId: string): Promise<number> =>
  Number((await db.sql(`SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId]))[0]?.n);

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(100);
  }
}

describe('process lifecycle', () => {
  test('a full-role process consumes, publishes, and exits cleanly on SIGTERM without losing a message', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = await services.openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' }, actor: 't', correlationId: 'c' });
    const app = await startApp(env());

    await queues.send(bet(wallet.id, playerId), wallet.id);
    await until(async () => (await debits(wallet.id)) === 1, 15_000);
    await until(async () => Number((await db.sql('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL'))[0]?.n) === 0, 15_000);

    await queues.send(bet(wallet.id, playerId), wallet.id);
    const exitCode = await app.kill('SIGTERM');

    expect(exitCode).toBe(0);
    expect(app.output()).toContain('background workers stopped');
    // A message caught by the aborted long poll reappears once its 30s visibility timeout lapses: delayed, not lost.
    let leftover = 0;
    await until(async () => {
      leftover += (await queues.drain(queues.wagerUrl, 2)).length;
      return (await debits(wallet.id)) + leftover === 2;
    }, 45_000);
    await assertLedgerInvariant(db, wallet.id);
  });
});
