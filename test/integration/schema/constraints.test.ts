import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { constraintOf, createTestDatabase, sqlStateOf, type TestDatabase } from '../../support/db';
import { insertTx, insertWallet, uuid } from '../../support/fixtures-sql';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe('wallets', () => {
  test('balance cannot be negative', async () => {
    expect(await sqlStateOf(insertWallet(db, { balance: -1n }))).toBe('23514');
  });

  test('one wallet per player and currency', async () => {
    const playerId = uuid();
    await insertWallet(db, { playerId });
    expect(await constraintOf(insertWallet(db, { playerId }))).toBe('wallets_player_currency_key');
    await insertWallet(db, { playerId, currency: 'USD' });
  });

  test('version starts at one', async () => {
    expect(await sqlStateOf(insertWallet(db, { version: 0 }))).toBe('23514');
  });
});

describe('wager_transactions', () => {
  test('BET needs a positive amount, LOSS may be zero', async () => {
    const walletId = await insertWallet(db);
    expect(await sqlStateOf(insertTx(db, { walletId, kind: 'BET', amount: 0n }))).toBe('23514');
    await insertTx(db, { walletId, kind: 'LOSS', amount: 0n });
  });

  test('REFUND and ROLLBACK need a reference', async () => {
    const walletId = await insertWallet(db);
    expect(await constraintOf(insertTx(db, { walletId, kind: 'REFUND' }))).toBe('wager_tx_reversal_has_reference');
    expect(await constraintOf(insertTx(db, { walletId, kind: 'ROLLBACK' }))).toBe('wager_tx_reversal_has_reference');
  });

  test('REJECTED needs a failure code and PROCESSED cannot carry one', async () => {
    const walletId = await insertWallet(db);
    expect(await constraintOf(insertTx(db, { walletId, status: 'REJECTED' }))).toBe(
      'wager_tx_failure_code_matches_status',
    );
    expect(
      await constraintOf(insertTx(db, { walletId, status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' })),
    ).toBe('wager_tx_failure_code_matches_status');
  });

  test('unknown kind and status are refused', async () => {
    const walletId = await insertWallet(db);
    expect(await sqlStateOf(insertTx(db, { walletId, kind: 'JACKPOT' }))).toBe('23514');
    expect(await sqlStateOf(insertTx(db, { walletId, status: 'DONE' }))).toBe('23514');
  });

  test('a transaction can be reversed only once, whatever the reversal kind', async () => {
    const walletId = await insertWallet(db);
    const betId = await insertTx(db, { walletId, status: 'PROCESSED' });
    await insertTx(db, {
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceExternalId: 'bet',
      referenceTransactionId: betId,
    });
    expect(
      await constraintOf(
        insertTx(db, {
          walletId,
          kind: 'ROLLBACK',
          status: 'PROCESSED',
          referenceExternalId: 'bet',
          referenceTransactionId: betId,
        }),
      ),
    ).toBe('wager_tx_single_reversal_idx');
  });

  test('idempotency keys and external ids are unique per provider', async () => {
    const walletId = await insertWallet(db);
    await insertTx(db, { walletId, providerId: 'provider-a', externalId: 'same', idempotencyKey: 'k-1' });
    expect(
      await constraintOf(insertTx(db, { walletId, providerId: 'provider-a', externalId: 'other', idempotencyKey: 'k-1' })),
    ).toBe('wager_tx_provider_idempotency_key');
    expect(
      await constraintOf(insertTx(db, { walletId, providerId: 'provider-a', externalId: 'same', idempotencyKey: 'k-2' })),
    ).toBe('wager_tx_provider_external_key');
    await insertTx(db, { walletId, providerId: 'provider-b', externalId: 'same', idempotencyKey: 'k-1' });
  });

  test('pending reference must be scheduled', async () => {
    const walletId = await insertWallet(db);
    expect(
      await constraintOf(
        insertTx(db, { walletId, kind: 'REFUND', referenceExternalId: 'x', status: 'PENDING_REFERENCE' }),
      ),
    ).toBe('wager_tx_pending_reference_scheduled');
  });
});

describe('ledger_entries', () => {
  async function ledgerInsert(values: {
    direction: string;
    amount: bigint;
    before: bigint;
    after: bigint;
    walletId: string;
    txId: string;
  }): Promise<unknown> {
    return db.sql(
      `INSERT INTO ledger_entries (id, transaction_id, account_type, account_id, wallet_id, direction,
         amount_minor, currency, balance_before_minor, balance_after_minor, wallet_version, created_at)
       VALUES ($1, $2, 'WALLET', $3::text, $3::uuid, $4, $5, 'BRL', $6, $7, 2, now())`,
      [uuid(), values.txId, values.walletId, values.direction, values.amount, values.before, values.after],
    );
  }

  test('wallet postings must add up', async () => {
    const walletId = await insertWallet(db);
    const txId = await insertTx(db, { walletId });
    expect(
      await constraintOf(ledgerInsert({ direction: 'DEBIT', amount: 30n, before: 100n, after: 80n, walletId, txId })),
    ).toBe('ledger_wallet_arithmetic');
  });

  test('wallet postings cannot go negative', async () => {
    const walletId = await insertWallet(db);
    const txId = await insertTx(db, { walletId });
    expect(
      await sqlStateOf(ledgerInsert({ direction: 'DEBIT', amount: 30n, before: 10n, after: -20n, walletId, txId })),
    ).toBe('23514');
  });

  test('counterpart postings carry no wallet balance', async () => {
    const walletId = await insertWallet(db);
    const txId = await insertTx(db, { walletId });
    expect(
      await constraintOf(
        db.sql(
          `INSERT INTO ledger_entries (id, transaction_id, account_type, account_id, wallet_id, direction,
             amount_minor, currency, balance_before_minor, balance_after_minor, wallet_version, created_at)
           VALUES ($1, $2, 'PROVIDER_CLEARING', 'provider-a:BRL', NULL, 'CREDIT', 10, 'BRL', 0, 10, NULL, now())`,
          [uuid(), txId],
        ),
      ),
    ).toBe('ledger_counterpart_columns');
  });

  test('wallet postings need every wallet column', async () => {
    const walletId = await insertWallet(db);
    const txId = await insertTx(db, { walletId });
    expect(
      await constraintOf(
        db.sql(
          `INSERT INTO ledger_entries (id, transaction_id, account_type, account_id, wallet_id, direction,
             amount_minor, currency, balance_before_minor, balance_after_minor, wallet_version, created_at)
           VALUES ($1, $2, 'WALLET', $3::text, $3::uuid, 'CREDIT', 10, 'BRL', 0, 10, NULL, now())`,
          [uuid(), txId, walletId],
        ),
      ),
    ).toBe('ledger_wallet_columns');
  });
});

describe('migrations', () => {
  test('roll all the way down and back up', async () => {
    const scratch = await createTestDatabase();
    const orm = await MikroORM.init(createOrmConfig({ databaseUrl: scratch.url, poolMax: 2 }));
    try {
      await orm.migrator.down({ to: 0 });
      const afterDown = await scratch.sql(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
      );
      expect(afterDown[0]?.n).toBe(0);
      await orm.migrator.up();
      const afterUp = await scratch.sql(`SELECT to_regclass('public.wager_transactions') IS NOT NULL AS ok`);
      expect(afterUp[0]?.ok).toBe(true);
    } finally {
      await orm.close(true);
      await scratch.drop();
    }
  });
});
