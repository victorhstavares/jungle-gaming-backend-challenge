import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletOpened } from '../../../src/domain/events/wallet-events';
import { CounterpartEntry, LedgerAccountType } from '../../../src/domain/ledger/ledger-entry';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { TransientInfrastructureError, UniqueViolationError } from '../../../src/application/errors';
import type { MikroOrmTransactionRunner } from '../../../src/infrastructure/persistence/transaction-runner';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { openOrm, runnerFor } from '../../support/orm';

let db: TestDatabase;
let orm: MikroORM;
let runner: MikroOrmTransactionRunner;
const ctx = { correlationId: 'corr-repo' };
const brl = (minor: bigint): Money => Money.ofMinor(minor, 'BRL');
const now = new Date('2026-10-23T12:00:00.000Z');

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  runner = runnerFor(orm);
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

async function openWallet(balance: bigint): Promise<Wallet> {
  const walletId = Bun.randomUUIDv7();
  const openingTx = Bun.randomUUIDv7();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: Bun.randomUUIDv7(),
    initialBalance: brl(balance),
    now,
    openingTransactionId: openingTx,
    openingEntryId: Bun.randomUUIDv7(),
  });
  await runner.run(ctx, async (repos) => {
    await repos.wallets.insert(wallet);
    if (openingEntry !== undefined) {
      await repos.transactions.insert(
        WagerTransaction.createOpening({ id: openingTx, walletId, playerId: wallet.playerId, money: brl(balance), now }),
      );
      await repos.ledger.insert(
        openingEntry,
        CounterpartEntry.for(openingEntry, LedgerAccountType.SystemOpening, 'BRL', Bun.randomUUIDv7()),
      );
    }
  });
  return wallet;
}

describe('wallets', () => {
  test('round-trips a wallet and persists a debit with its postings', async () => {
    const opened = await openWallet(10_000n);

    await runner.run(ctx, async (repos) => {
      const wallet = await repos.wallets.lockById(opened.id);
      if (wallet === undefined) throw new Error('wallet missing');
      const txId = Bun.randomUUIDv7();
      await repos.transactions.insert(
        WagerTransaction.rehydrate({
          id: txId, providerId: 'provider-a', externalTransactionId: 'bet-1', idempotencyKey: 'provider-a:bet-1',
          payloadHash: 'b'.repeat(64), walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g',
          kind: 'BET' as never, money: brl(2_500n), createdAt: now, status: 'PROCESSED' as never, attempts: 0,
          processedAt: now, resultBalance: brl(7_500n),
        }),
      );
      const entry = wallet.debit(brl(2_500n), txId, Bun.randomUUIDv7(), now);
      await repos.wallets.update(wallet);
      await repos.ledger.insert(entry, CounterpartEntry.for(entry, LedgerAccountType.ProviderClearing, 'provider-a:BRL', Bun.randomUUIDv7()));
    });

    const reloaded = await runner.run(ctx, (repos) => repos.wallets.findById(opened.id));
    expect(reloaded?.balance.toMinor()).toBe(7_500n);
    expect(reloaded?.version).toBe(2);
    const sum = await runner.run(ctx, (repos) => repos.ledger.sumForWallet(opened.id));
    expect(sum).toEqual({ balanceMinor: 7_500n, entries: 2 });
  });

  test('a second transaction waits for the wallet row lock', async () => {
    const wallet = await openWallet(1_000n);
    const timeline: string[] = [];

    const first = runner.run(ctx, async (repos) => {
      await repos.wallets.lockById(wallet.id);
      timeline.push('first-locked');
      await Bun.sleep(300);
      timeline.push('first-commit');
    });
    await Bun.sleep(50);
    const second = runner.run(ctx, async (repos) => {
      await repos.wallets.lockById(wallet.id);
      timeline.push('second-locked');
    });

    await Promise.all([first, second]);
    expect(timeline).toEqual(['first-locked', 'first-commit', 'second-locked']);
  });

  test('a lock held longer than lock_timeout surfaces as a transient error', async () => {
    const wallet = await openWallet(1_000n);
    const impatient = runnerFor(orm, 100);

    const holder = runner.run(ctx, async (repos) => {
      await repos.wallets.lockById(wallet.id);
      await Bun.sleep(500);
    });
    await Bun.sleep(50);
    const error = await impatient
      .run(ctx, (repos) => repos.wallets.lockById(wallet.id))
      .then(() => undefined, (e: unknown) => e);
    await holder;

    expect(error).toBeInstanceOf(TransientInfrastructureError);
  });

  test('duplicate player and currency is classified with its constraint', async () => {
    const wallet = await openWallet(0n);
    const clone = Wallet.rehydrate({
      id: Bun.randomUUIDv7(), playerId: wallet.playerId, currency: 'BRL', balance: brl(0n), version: 1,
      createdAt: now, updatedAt: now,
    });
    const error = await runner.run(ctx, (repos) => repos.wallets.insert(clone)).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wallets_player_currency_key');
  });
});

describe('inbox', () => {
  test('a message is received once', async () => {
    const msg = (): InboxMessage =>
      InboxMessage.receive({ messageId: 'msg-1', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: now });

    expect(await runner.run(ctx, (repos) => repos.inbox.tryReceive(msg()))).toBe(true);
    expect(await runner.run(ctx, (repos) => repos.inbox.tryReceive(msg()))).toBe(false);
  });

  test('a rolled back receive leaves no trace', async () => {
    const msg = InboxMessage.receive({ messageId: 'msg-2', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: now });
    await runner
      .run(ctx, async (repos) => {
        await repos.inbox.tryReceive(msg);
        throw new Error('abort');
      })
      .catch(() => undefined);

    expect(await runner.run(ctx, (repos) => repos.inbox.tryReceive(msg))).toBe(true);
  });
});

describe('outbox', () => {
  test('concurrent claims never hand out the same message', async () => {
    const wallet = await openWallet(0n);
    await runner.run(ctx, async (repos) => {
      const messages = Array.from({ length: 30 }, () =>
        OutboxMessage.enqueue(
          WalletOpened.from(wallet, { eventId: Bun.randomUUIDv7(), correlationId: 'c', occurredAt: now }),
        ),
      );
      await repos.outbox.enqueue(messages);
    });

    const claim = (): Promise<string[]> =>
      runner.run(ctx, async (repos) => (await repos.outbox.claim(new Date(), 20, 30_000)).map((m) => m.id));
    const [a, b] = await Promise.all([claim(), claim()]);

    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(new Set([...a, ...b]).size).toBeGreaterThanOrEqual(30);
  });
});
