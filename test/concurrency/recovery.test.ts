import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { assertLedgerInvariant } from '../support/invariants';
import { wagerMessage } from '../support/sqs';
import { count, openWallet, request, startCluster, submit, until, wager, type Cluster } from './harness';

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster(3);
});

afterAll(async () => {
  await $`docker compose unpause postgres`.quiet().nothrow();
  await cluster.stop();
});

describe('README §13 recovery', () => {
  test('8. killing every instance mid-load and restarting ends consistent, with nothing lost', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(cluster, '100.00')));
    const accepted: string[] = [];

    const load = Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 30 }, async (_, i) => {
          const body = wager(walletId, playerId);
          if (i % 3 === 0) {
            await cluster.queues.send(
              wagerMessage({ ...body, idempotencyKey: `provider-a:${String(body.externalTransactionId)}` }),
              walletId,
            );
            accepted.push(String(body.externalTransactionId));
            return;
          }
          const res = await submit(cluster, w + i, body).catch(() => undefined);
          if (res !== undefined && [201, 202, 422].includes(res.status)) accepted.push(String(body.externalTransactionId));
        }),
      ),
    );
    await Bun.sleep(150);
    await Promise.all(cluster.apps.map((app) => app.kill('SIGKILL')));
    await load;

    await Promise.all([0, 1, 2].map((i) => cluster.restart(i)));
    await until(
      async () =>
        (await count(cluster.db, `SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)) === 0 &&
        (await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')`)) === 0,
      60_000,
      'outbox drained and nothing pending',
    );
    // Queued bets are all applied once the consumers come back.
    await until(
      async () => {
        const found = await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ANY($1::text[])`, [accepted]);
        return found === accepted.length;
      },
      60_000,
      'every accepted operation persisted',
    );

    for (const { walletId } of wallets) {
      const rec = await request(cluster.apps[0]?.url ?? '', 'POST', `/wallets/${walletId}/reconciliation`, cluster.operator);
      expect(rec.body.consistent).toBe(true);
    }
    await assertLedgerInvariant(cluster.db);
  });

  test('a Postgres outage answers 503 with Retry-After, and the same requests succeed once without duplicates', async () => {
    const { walletId, playerId } = await openWallet(cluster, '100.00');
    const bodies = Array.from({ length: 5 }, () => wager(walletId, playerId));

    await $`docker compose pause postgres`.quiet();
    let during: Awaited<ReturnType<typeof submit>>[];
    try {
      during = await Promise.all(bodies.map((body, i) => submit(cluster, i, body)));
    } finally {
      await $`docker compose unpause postgres`.quiet();
    }

    expect(during.map((r) => r.status)).toEqual([503, 503, 503, 503, 503]);
    expect(during.every((r) => r.headers.get('retry-after') === '1')).toBe(true);
    expect(during.every((r) => r.body.code === 'TEMPORARILY_UNAVAILABLE')).toBe(true);

    await until(async () => (await request(cluster.apps[0]?.url ?? '', 'GET', '/health/ready', '')).status === 200, 30_000, 'ready again');
    const after = await Promise.all(bodies.map((body, i) => submit(cluster, i, body)));
    expect(after.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await count(cluster.db, `SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).toBe(5);
    await assertLedgerInvariant(cluster.db, walletId);
  });
});
