import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertLedgerInvariant } from '../support/invariants';
import { wagerMessage } from '../support/sqs';
import { count, openWallet, request, startCluster, submit, until, wager, type Cluster } from './harness';

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster(3);
});

afterAll(async () => {
  await cluster.stop();
});

const balanceOf = async (walletId: string): Promise<string> =>
  String((await cluster.db.sql('SELECT balance_minor::text AS b FROM wallets WHERE id = $1', [walletId]))[0]?.b);

describe('README §13 concurrency, against 3 real instances', () => {
  test('1. the same bet sent 50 times in parallel debits once', async () => {
    const { walletId, playerId } = await openWallet(cluster, '1000.00');
    const body = wager(walletId, playerId, { money: { amount: '25.00', currency: 'BRL' } });

    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(cluster, i, body)));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((r) => JSON.stringify(r.body.balance))).size).toBe(1);
    expect(await count(cluster.db, `SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).toBe(1);
    expect(await balanceOf(walletId)).toBe('97500');
    await assertLedgerInvariant(cluster.db, walletId);
  });

  test('2. two 80.00 bets race for 100.00: one wins, one is rejected, 20.00 left', async () => {
    const { walletId, playerId } = await openWallet(cluster, '100.00');
    const bets = [0, 1].map(() => wager(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } }));

    const [a, b] = await Promise.all(bets.map((body, i) => submit(cluster, i, body)));

    const statuses = [a?.body.status, b?.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect([a?.body.failureCode, b?.body.failureCode]).toContain('INSUFFICIENT_FUNDS');
    expect(await balanceOf(walletId)).toBe('2000');
    expect(await count(cluster.db, `SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).toBe(1);

    const retried = await Promise.all(bets.map((body, i) => submit(cluster, i + 1, body)));
    expect(retried.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(await balanceOf(walletId)).toBe('2000');
    await assertLedgerInvariant(cluster.db, walletId);
  });

  test('3. distinct wallets are processed in parallel and all come out right', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(cluster, '100.00')));

    const started = performance.now();
    const responses = await Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 10 }, (_, i) => submit(cluster, w + i, wager(walletId, playerId))),
      ),
    );
    const elapsedMs = performance.now() - started;

    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const { walletId } of wallets) expect(await balanceOf(walletId)).toBe('9000');
    await assertLedgerInvariant(cluster.db);
    expect(elapsedMs).toBeLessThan(15_000);
  });

  test('4. 300 mixed operations on one hot wallet through HTTP and SQS never go negative', async () => {
    const { walletId, playerId } = await openWallet(cluster, '50.00');
    const kinds = ['BET', 'BET', 'BET', 'WIN', 'LOSS'];
    const bodies = Array.from({ length: 300 }, (_, i) => {
      const kind = kinds[i % kinds.length] ?? 'BET';
      return wager(walletId, playerId, { kind, money: { amount: kind === 'LOSS' ? '0.00' : '3.00', currency: 'BRL' } });
    });
    const viaHttp = bodies.slice(0, 200);
    const viaQueue = bodies.slice(200);

    await Promise.all([
      ...viaHttp.map((body, i) => submit(cluster, i, body)),
      ...viaQueue.map((data) =>
        cluster.queues.send(wagerMessage({ ...data, idempotencyKey: `provider-a:${String(data.externalTransactionId)}` }), walletId),
      ),
    ]);
    await until(
      async () => (await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'`, [walletId])) === 300,
      60_000,
      'all 300 operations settled',
    );

    expect(await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status NOT IN ('PROCESSED', 'REJECTED')`, [walletId])).toBe(0);
    expect(Number(await balanceOf(walletId))).toBeGreaterThanOrEqual(0);
    const rejected = await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'REJECTED'`, [walletId]);
    expect(rejected).toBeGreaterThan(0);
    const reconciliation = await request(cluster.apps[2]?.url ?? '', 'POST', `/wallets/${walletId}/reconciliation`, cluster.operator);
    expect(reconciliation.body.consistent).toBe(true);
    await assertLedgerInvariant(cluster.db, walletId);
  });

  test('7. a ROLLBACK and a REFUND that arrive before their BET settle once the BET lands', async () => {
    const { walletId, playerId } = await openWallet(cluster, '100.00');
    const betA = wager(walletId, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    const betB = wager(walletId, playerId, { money: { amount: '20.00', currency: 'BRL' } });
    const refund = wager(walletId, playerId, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: betA.externalTransactionId });
    const rollback = wager(walletId, playerId, { kind: 'ROLLBACK', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: betB.externalTransactionId });
    const asMessage = (data: Record<string, unknown>): string =>
      wagerMessage({ ...data, idempotencyKey: `provider-a:${String(data.externalTransactionId)}` });

    await cluster.queues.send(asMessage(refund), `${walletId}-r`);
    await cluster.queues.send(asMessage(rollback), `${walletId}-b`);
    await until(
      async () => (await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'PENDING_REFERENCE'`, [walletId])) === 2,
      20_000,
      'both reversals waiting',
    );

    await submit(cluster, 0, betA);
    await submit(cluster, 1, betB);
    await until(
      async () => (await count(cluster.db, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`, [walletId])) === 2,
      20_000,
      'both reversals settled',
    );

    expect(await balanceOf(walletId)).toBe('10000');
    await assertLedgerInvariant(cluster.db, walletId);
  });
});
