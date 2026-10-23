import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ContractError,
  InvalidCursorError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { WagerQueries } from '../../../src/application/wagering/wager-queries';
import { ReconcileWallet } from '../../../src/application/wallets/reconcile-wallet';
import { WalletQueries } from '../../../src/application/wallets/wallet-queries';
import { createTestDatabase, rejectionOf, type TestDatabase } from '../../support/db';
import { openOrm } from '../../support/orm';
import { buildServices, httpCtx, wagerCommand } from '../../support/services';

let db: TestDatabase;
let orm: MikroORM;
let services: ReturnType<typeof buildServices>;
let wallets: WalletQueries;
let wagers: WagerQueries;
let reconcile: ReconcileWallet;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  services = buildServices(orm);
  wallets = new WalletQueries(services.runner);
  wagers = new WagerQueries(services.runner);
  reconcile = new ReconcileWallet(services.runner, services.clock, { next: () => Bun.randomUUIDv7() }, services.logger, services.metrics);
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

async function walletWithMovements(movements: number): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const view = await services.openWallet.execute({
    playerId,
    initialBalance: { amount: '1000.00', currency: 'BRL' },
    actor: 'backoffice',
    correlationId: 'setup',
  });
  for (let i = 0; i < movements; i += 1) {
    await services.processWager.execute(
      wagerCommand(view.id, playerId, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }),
      httpCtx(),
    );
  }
  return { walletId: view.id, playerId };
}

describe('wallet', () => {
  test('returns the README shape', async () => {
    const { walletId, playerId } = await walletWithMovements(1);
    expect(await wallets.getWallet(walletId)).toEqual({
      id: walletId,
      playerId,
      balance: { amount: '1001.00', currency: 'BRL' },
      version: 2,
    });
  });

  test('unknown wallet', async () => {
    expect(await rejectionOf(wallets.getWallet(Bun.randomUUIDv7()))).toBeInstanceOf(WalletNotFoundError);
  });
});

describe('ledger pagination', () => {
  test('walks every entry once, in order, with an opaque stable cursor', async () => {
    const { walletId } = await walletWithMovements(119);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await wallets.listLedger(walletId, cursor, 50);
      pages += 1;
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      if (page.nextCursor !== null) expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    const first = await wallets.listLedger(walletId, undefined, 1);
    expect(first.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test.each(['@@@', Buffer.from('abc').toString('base64url'), Buffer.from('-1').toString('base64url'), Buffer.from('99999999999999999999').toString('base64url')])(
    'rejects tampered cursor %p',
    async (cursor) => {
      const { walletId } = await walletWithMovements(0);
      expect(await rejectionOf(wallets.listLedger(walletId, cursor, 50))).toBeInstanceOf(InvalidCursorError);
    },
  );

  test.each([0, 201, 1.5])('rejects limit %p', async (limit) => {
    const { walletId } = await walletWithMovements(0);
    expect(await rejectionOf(wallets.listLedger(walletId, undefined, limit))).toBeInstanceOf(ContractError);
  });
});

describe('transactions', () => {
  test('are found by id and by provider external id', async () => {
    const { walletId, playerId } = await walletWithMovements(0);
    const cmd = wagerCommand(walletId, playerId);
    const result = await services.processWager.execute(cmd, httpCtx());

    const byId = await wagers.getTransaction(result.transactionId ?? '');
    const byExternal = await wagers.getTransactionByExternalId('provider-a', cmd.externalTransactionId);
    expect(byId).toEqual(byExternal);
    expect(byId).toMatchObject({
      id: result.transactionId,
      providerId: 'provider-a',
      externalTransactionId: cmd.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      resultBalance: { amount: '975.00', currency: 'BRL' },
    });
    expect(await rejectionOf(wagers.getTransaction(Bun.randomUUIDv7()))).toBeInstanceOf(TransactionNotFoundError);
  });
});

describe('reconciliation', () => {
  test('reports a consistent wallet and records the run', async () => {
    const { walletId } = await walletWithMovements(3);
    const report = await reconcile.execute(walletId, 'backoffice', 'corr-rec');

    expect(report).toEqual({
      walletId,
      storedBalance: { amount: '1003.00', currency: 'BRL' },
      calculatedBalance: { amount: '1003.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
    });
    const runs = await db.sql('SELECT consistent FROM reconciliation_runs WHERE wallet_id = $1', [walletId]);
    expect(runs).toEqual([{ consistent: true }]);
  });

  test('flags a tampered balance without correcting it', async () => {
    const { walletId } = await walletWithMovements(1);
    await db.transaction(async (run) => {
      await run('SET LOCAL session_replication_role = replica');
      await run('UPDATE wallets SET balance_minor = balance_minor + 1 WHERE id = $1', [walletId]);
    });

    const report = await reconcile.execute(walletId, 'backoffice', 'corr-tamper');

    expect(report).toMatchObject({ consistent: false, difference: { amount: '0.01', currency: 'BRL' } });
    expect(services.metrics.count('reconciliation_mismatches_total')).toBeGreaterThanOrEqual(1);
    expect(services.logger.lines.some((l) => l.level === 'error' && l.fields.walletId === walletId)).toBe(true);
    const [row] = await db.sql('SELECT balance_minor::text AS b FROM wallets WHERE id = $1', [walletId]);
    expect(row?.b).toBe('100101');
  });
});
