import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Message } from '@aws-sdk/client-sqs';
import { PublishOutboxBatch } from '../../../src/application/outbox/publish-outbox-batch';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { ProcessExitFaultInjector } from '../../../src/infrastructure/fault/fault-injector';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { SystemClock } from '../../../src/infrastructure/system';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { RecordingLogger, RecordingMetrics } from '../../support/observability';
import { openOrm, runnerFor } from '../../support/orm';
import { buildServices, httpCtx, wagerCommand } from '../../support/services';
import { createTestQueues, sqs, type TestQueues } from '../../support/sqs';
import { SQSClient } from '@aws-sdk/client-sqs';

let db: TestDatabase;
let orm: MikroORM;
let queues: TestQueues;
let services: ReturnType<typeof buildServices>;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url, 20);
  queues = await createTestQueues();
  services = buildServices(orm);
});

afterAll(async () => {
  await queues.destroy();
  await orm.close(true);
  await db.drop();
});

function publisher(metrics = new RecordingMetrics(), eventsSqs = sqs, leaseMs = 30_000): PublishOutboxBatch {
  return new PublishOutboxBatch(
    runnerFor(orm),
    new SqsEventPublisher(eventsSqs, queues.eventsUrl),
    new SystemClock(),
    new RecordingLogger(),
    metrics,
    new ProcessExitFaultInjector(undefined),
    { batchSize: 25, leaseMs },
  );
}

async function produceEvents(bets: number): Promise<void> {
  const playerId = Bun.randomUUIDv7();
  const wallet = await services.openWallet.execute({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' }, actor: 't', correlationId: 'c' });
  for (let i = 0; i < bets; i += 1) {
    await services.processWager.execute(wagerCommand(wallet.id, playerId, { money: { amount: '1.00', currency: 'BRL' } }), httpCtx());
  }
}

const pending = async (): Promise<number> =>
  Number((await db.sql('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL'))[0]?.n);

/** A downstream consumer that remembers event ids in its own inbox, as the README asks of consumers. */
async function applyOnce(messages: Message[]): Promise<{ applied: number; ignored: number }> {
  const runner = runnerFor(orm);
  let applied = 0;
  let ignored = 0;
  for (const message of messages) {
    const event = JSON.parse(message.Body ?? '{}') as { eventId: string };
    const fresh = await runner.run({ correlationId: event.eventId }, (repos) =>
      repos.inbox.tryReceive(
        InboxMessage.receive({ consumerName: 'events-test-consumer', messageId: event.eventId, payloadHash: 'e'.repeat(64), receivedAt: new Date() }),
      ),
    );
    if (fresh) applied += 1;
    else ignored += 1;
  }
  return { applied, ignored };
}

describe('PublishOutboxBatch', () => {
  test('two concurrent publishers drain the outbox without publishing anything twice', async () => {
    await produceEvents(60);
    const total = await pending();
    expect(total).toBe(122);

    const drain = async (p: PublishOutboxBatch): Promise<void> => {
      while ((await p.execute()).published > 0) {
        // keep going until this publisher finds nothing left to claim
      }
    };
    await Promise.all([drain(publisher()), drain(publisher())]);

    expect(await pending()).toBe(0);
    const delivered = await queues.drain(queues.eventsUrl);
    const ids = delivered.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(delivered[0]?.MessageAttributes?.eventType?.StringValue).toBeString();
  });

  test('a failed publish is rescheduled with backoff and the error is kept', async () => {
    await produceEvents(1);
    const metrics = new RecordingMetrics();
    const unreachable = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:1', maxAttempts: 1 });

    const result = await publisher(metrics, unreachable).execute();

    expect(result.failed).toBeGreaterThan(0);
    const attempted = await db.sql(
      `SELECT attempts, next_attempt_at > now() AS later, last_error IS NOT NULL AS has_error, locked_until
         FROM outbox_messages WHERE published_at IS NULL AND attempts > 0`,
    );
    expect(attempted).toHaveLength(result.failed);
    for (const row of attempted) expect(row).toEqual({ attempts: 1, later: true, has_error: true, locked_until: null });
    expect(metrics.count('outbox_publish_failures_total')).toBe(result.failed);
    expect(metrics.gauges.get('outbox_lag_seconds{}')).toBeGreaterThanOrEqual(0);

    await db.sql(`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`);
    while ((await publisher().execute()).published > 0) {
      // one event per aggregate per round, oldest first
    }
    expect(await pending()).toBe(0);
    await queues.drain(queues.eventsUrl);
  });

  test('a later event of an aggregate waits while an earlier one is still unpublished', async () => {
    await produceEvents(1);
    const [oldest] = await db.sql(
      `SELECT id, aggregate_id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT 1`,
    );
    await db.sql(`UPDATE outbox_messages SET next_attempt_at = now() + interval '1 hour', attempts = 1 WHERE id = $1`, [oldest?.id]);
    await db.sql(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, 'WalletBalanceChanged', '{}'::jsonb, now() + interval '1 second', 0, now())`,
      [Bun.randomUUIDv7(), oldest?.aggregate_id],
    );

    const pendingFor = async (): Promise<number> =>
      Number((await db.sql(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`, [oldest?.aggregate_id]))[0]?.n);
    const before = await pendingFor();

    while ((await publisher().execute()).published > 0) {
      // publish everything that is eligible
    }

    expect(before).toBeGreaterThanOrEqual(2);
    expect(await pendingFor()).toBe(before);
    await db.sql(`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`);
    while ((await publisher().execute()).published > 0) {
      // drain once the earlier event is due again
    }
    await queues.drain(queues.eventsUrl);
  });

  test('a publisher that dies after publishing is taken over, and the consumer applies each event once', async () => {
    await produceEvents(3);
    const expected = await pending();

    const child = Bun.spawn(['bun', 'test/support/outbox-child.ts'], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: db.url, EVENTS_QUEUE_URL: queues.eventsUrl, FAULT_INJECTION: 'outbox.afterPublishBeforeMark' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(137);
    expect(await pending()).toBe(expected);

    await Bun.sleep(1_200);
    while ((await publisher(new RecordingMetrics(), sqs, 1_000).execute()).published > 0) {
      // drain after the dead publisher's lease expired
    }

    expect(await pending()).toBe(0);
    const delivered = await queues.drain(queues.eventsUrl);
    const outcome = await applyOnce([...delivered, ...delivered]);
    expect(outcome.applied).toBe(expected);
    expect(outcome.ignored).toBe(delivered.length * 2 - expected);
  });
});
