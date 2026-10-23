import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../../support/db';
import { insertTx, insertWallet, txInsert, uuid } from '../../support/fixtures-sql';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

const LEDGER_INSERT = `
  INSERT INTO ledger_entries (id, transaction_id, account_type, account_id, wallet_id, direction, amount_minor,
    currency, balance_before_minor, balance_after_minor, wallet_version, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'BRL', $8, $9, $10, now())`;

type Run = (text: string, params?: unknown[]) => Promise<unknown>;

/** Posts a balanced movement the way the application will: wallet update, wallet entry, counterpart entry. */
async function postMovement(
  run: Run,
  m: { walletId: string; txId: string; direction: 'DEBIT' | 'CREDIT'; amount: bigint; before: bigint; version: number },
): Promise<void> {
  const after = m.direction === 'CREDIT' ? m.before + m.amount : m.before - m.amount;
  await run(`UPDATE wallets SET balance_minor = $2, version = $3, updated_at = now() WHERE id = $1`, [
    m.walletId,
    after,
    m.version,
  ]);
  await run(LEDGER_INSERT, [
    uuid(), m.txId, 'WALLET', m.walletId, m.walletId, m.direction, m.amount, m.before, after, m.version,
  ]);
  await run(LEDGER_INSERT, [
    uuid(), m.txId, 'PROVIDER_CLEARING', 'provider-a:BRL', null,
    m.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', m.amount, null, null, null,
  ]);
}

async function walletWithOpening(balance: bigint): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const walletId = uuid();
  await db.transaction(async (run) => {
    await run(
      `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', $3, 1, now(), now())`,
      [walletId, playerId, balance],
    );
    const [text, params] = txInsert({ walletId, playerId, kind: 'OPENING', amount: balance, status: 'PROCESSED' });
    await run(text, params);
    const txId = String(params[0]);
    await run(LEDGER_INSERT, [uuid(), txId, 'WALLET', walletId, walletId, 'CREDIT', balance, 0n, balance, 1]);
    await run(LEDGER_INSERT, [uuid(), txId, 'SYSTEM_OPENING', 'BRL', null, 'DEBIT', balance, null, null, null]);
  });
  return { walletId, playerId };
}

describe('append-only tables', () => {
  test.each(['UPDATE ledger_entries SET amount_minor = 1', 'DELETE FROM ledger_entries', 'TRUNCATE ledger_entries CASCADE'])(
    '%s is refused',
    async (statement) => {
      await walletWithOpening(1000n);
      expect(await sqlStateOf(db.sql(statement))).toBe('P0001');
    },
  );

  test.each([
    'UPDATE audit_log SET actor = $$x$$',
    'DELETE FROM audit_log',
    'DELETE FROM wager_transaction_status_history',
    'DELETE FROM reconciliation_runs',
  ])('%s is refused', async (statement) => {
    const walletId = await insertWallet(db);
    await insertTx(db, { walletId });
    await db.sql(
      `INSERT INTO audit_log (occurred_at, source, actor, operation, outcome, correlation_id)
       VALUES (now(), 'HTTP', 'test', 'SUBMIT_WAGER', 'PROCESSED', 'c')`,
    );
    await db.sql(
      `INSERT INTO reconciliation_runs (id, wallet_id, actor, correlation_id, currency, stored_balance_minor,
         calculated_balance_minor, difference_minor, checked_entries, consistent, checked_at)
       VALUES ($1, $2, 'test', 'c', 'BRL', 0, 0, 0, 0, true, now())`,
      [uuid(), walletId],
    );
    expect(await sqlStateOf(db.sql(statement))).toBe('P0001');
  });

  test('wager transactions cannot be deleted', async () => {
    const walletId = await insertWallet(db);
    await insertTx(db, { walletId });
    expect(await sqlStateOf(db.sql('DELETE FROM wager_transactions'))).toBe('P0001');
  });
});

describe('wallet and ledger stay in lockstep', () => {
  test('a balanced movement commits', async () => {
    const { walletId, playerId } = await walletWithOpening(10000n);
    await db.transaction(async (run) => {
      const [text, params] = txInsert({ walletId, playerId, status: 'PROCESSED', amount: 8000n });
      await run(text, params);
      await postMovement(run, { walletId, txId: String(params[0]), direction: 'DEBIT', amount: 8000n, before: 10000n, version: 2 });
    });
    const [row] = await db.sql('SELECT balance_minor, version FROM wallets WHERE id = $1', [walletId]);
    expect(row).toEqual({ balance_minor: '2000', version: 2 });
  });

  test('changing a balance without a ledger entry fails at commit', async () => {
    const { walletId } = await walletWithOpening(10000n);
    const failure = db.transaction(async (run) => {
      await run('UPDATE wallets SET balance_minor = 5, version = 2 WHERE id = $1', [walletId]);
    });
    expect(await sqlStateOf(failure)).toBe('P0001');
  });

  test('changing a balance without bumping the version is refused', async () => {
    const { walletId } = await walletWithOpening(10000n);
    expect(await sqlStateOf(db.sql('UPDATE wallets SET balance_minor = 5 WHERE id = $1', [walletId]))).toBe('P0001');
  });

  test('bumping the version without a balance change is refused', async () => {
    const { walletId } = await walletWithOpening(10000n);
    expect(await sqlStateOf(db.sql('UPDATE wallets SET version = 2 WHERE id = $1', [walletId]))).toBe('P0001');
  });

  test('a wallet posting without its counterpart fails at commit', async () => {
    const { walletId, playerId } = await walletWithOpening(10000n);
    const failure = db.transaction(async (run) => {
      const [text, params] = txInsert({ walletId, playerId, status: 'PROCESSED' });
      await run(text, params);
      await run('UPDATE wallets SET balance_minor = 9900, version = 2 WHERE id = $1', [walletId]);
      await run(LEDGER_INSERT, [uuid(), params[0], 'WALLET', walletId, walletId, 'DEBIT', 100n, 10000n, 9900n, 2]);
    });
    expect(await sqlStateOf(failure)).toBe('P0001');
  });

  test('a posting that does not continue the previous balance fails at commit', async () => {
    const { walletId, playerId } = await walletWithOpening(10000n);
    const failure = db.transaction(async (run) => {
      const [text, params] = txInsert({ walletId, playerId, status: 'PROCESSED' });
      await run(text, params);
      await postMovement(run, { walletId, txId: String(params[0]), direction: 'DEBIT', amount: 100n, before: 50000n, version: 2 });
    });
    expect(await sqlStateOf(failure)).toBe('P0001');
  });

  test('an empty wallet needs no ledger entry', async () => {
    const walletId = await insertWallet(db, { balance: 0n });
    expect(walletId).toBeString();
  });
});

describe('wager transaction status', () => {
  test('terminal transactions never change', async () => {
    const walletId = await insertWallet(db);
    const id = await insertTx(db, { walletId, status: 'PROCESSED' });
    expect(await sqlStateOf(db.sql(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [id]))).toBe('P0001');
  });

  test('business fields of a pending transaction are immutable', async () => {
    const walletId = await insertWallet(db);
    const id = await insertTx(db, { walletId });
    expect(await sqlStateOf(db.sql('UPDATE wager_transactions SET amount_minor = 1 WHERE id = $1', [id]))).toBe('P0001');
  });

  test('every status change is recorded with the correlation id', async () => {
    const walletId = await insertWallet(db);
    let id = '';
    await db.transaction(async (run) => {
      await run(`SELECT set_config('app.correlation_id', 'corr-42', true)`);
      const [text, params] = txInsert({ walletId, kind: 'REFUND', referenceExternalId: 'bet' });
      await run(text, params);
      id = String(params[0]);
      await run(
        `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', attempts = 1, next_attempt_at = now() WHERE id = $1`,
        [id],
      );
      await run(`UPDATE wager_transactions SET attempts = 2 WHERE id = $1`, [id]);
    });

    const history = await db.sql(
      `SELECT from_status, to_status, attempt, correlation_id FROM wager_transaction_status_history
       WHERE transaction_id = $1 ORDER BY id`,
      [id],
    );
    expect(history).toEqual([
      { from_status: null, to_status: 'PENDING', attempt: 0, correlation_id: 'corr-42' },
      { from_status: 'PENDING', to_status: 'PENDING_REFERENCE', attempt: 1, correlation_id: 'corr-42' },
      { from_status: 'PENDING_REFERENCE', to_status: 'PENDING_REFERENCE', attempt: 2, correlation_id: 'corr-42' },
    ]);
  });
});

describe('reconciliation runs', () => {
  test('difference and consistency must agree with the balances', async () => {
    const walletId = await insertWallet(db);
    const insert = (difference: bigint, consistent: boolean): Promise<unknown> =>
      db.sql(
        `INSERT INTO reconciliation_runs (id, wallet_id, actor, correlation_id, currency, stored_balance_minor,
           calculated_balance_minor, difference_minor, checked_entries, consistent, checked_at)
         VALUES ($1, $2, 'test', 'c', 'BRL', 100, 90, $3, 1, $4, now())`,
        [uuid(), walletId, difference, consistent],
      );
    expect(await sqlStateOf(insert(0n, true))).toBe('23514');
    expect(await sqlStateOf(insert(10n, true))).toBe('23514');
    expect(await sqlStateOf(insert(10n, false))).toBeUndefined();
  });
});
