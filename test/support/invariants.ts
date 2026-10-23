import { expect } from 'bun:test';
import type { TestDatabase } from './db';

/** wallet.balance == balance rebuilt from the ledger, and every transaction's postings net to zero. */
export async function assertLedgerInvariant(db: TestDatabase, walletId?: string): Promise<void> {
  const wallets = await db.sql(
    `SELECT w.id, w.balance_minor::text AS stored,
            coalesce((SELECT sum(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)
                        FROM ledger_entries l WHERE l.account_type = 'WALLET' AND l.wallet_id = w.id), 0)::text AS rebuilt
       FROM wallets w
      WHERE $1::uuid IS NULL OR w.id = $1::uuid`,
    [walletId ?? null],
  );
  for (const row of wallets) {
    expect({ wallet: row.id, balance: row.rebuilt }).toEqual({ wallet: row.id, balance: row.stored });
  }

  const unbalanced = await db.sql(
    `SELECT transaction_id FROM ledger_entries
      GROUP BY transaction_id
     HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0`,
  );
  expect(unbalanced).toEqual([]);

  const negative = await db.sql(`SELECT id FROM wallets WHERE balance_minor < 0`);
  expect(negative).toEqual([]);
}
