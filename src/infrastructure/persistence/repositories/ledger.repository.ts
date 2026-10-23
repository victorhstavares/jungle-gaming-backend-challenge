import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerPageItem, LedgerRepository } from '../../../application/ports/repositories';
import {
  LedgerAccountType,
  LedgerDirection,
  WalletLedgerEntry,
  type CounterpartEntry,
} from '../../../domain/ledger/ledger-entry';
import { Money } from '../../../domain/money/money';
import { asBigInt, asDate, asEnum, asNumber, asString, type SqlRow } from '../sql-values';

const INSERT = `
  INSERT INTO ledger_entries (id, transaction_id, account_type, account_id, wallet_id, direction, amount_minor,
    currency, balance_before_minor, balance_after_minor, wallet_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SIGNED_AMOUNT = `CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END`;

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry, counterpart: CounterpartEntry): Promise<void> {
    await this.em.execute(INSERT, [
      entry.id, entry.transactionId, LedgerAccountType.Wallet, entry.walletId, entry.walletId, entry.direction,
      entry.money.toMinor(), entry.money.currency, entry.balanceBefore.toMinor(), entry.balanceAfter.toMinor(),
      entry.walletVersion, entry.createdAt,
      counterpart.id, counterpart.transactionId, counterpart.accountType, counterpart.accountId, null,
      counterpart.direction, counterpart.money.toMinor(), counterpart.money.currency, null, null, null,
      counterpart.createdAt,
    ]);
  }

  async page(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.em.execute<SqlRow[]>(
      `SELECT seq, id, transaction_id, direction, amount_minor, currency, balance_before_minor,
              balance_after_minor, wallet_version, created_at
         FROM ledger_entries
        WHERE account_type = 'WALLET' AND wallet_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
      [walletId, afterSeq ?? 0n, limit],
    );
    return rows.map((row) => {
      const currency = asString(row.currency);
      return {
        seq: asBigInt(row.seq),
        entry: WalletLedgerEntry.rehydrate({
          id: asString(row.id),
          walletId,
          transactionId: asString(row.transaction_id),
          direction: asEnum(LedgerDirection, row.direction),
          money: Money.ofMinor(asBigInt(row.amount_minor), currency),
          balanceBefore: Money.ofMinor(asBigInt(row.balance_before_minor), currency),
          balanceAfter: Money.ofMinor(asBigInt(row.balance_after_minor), currency),
          walletVersion: asNumber(row.wallet_version),
          createdAt: asDate(row.created_at),
        }),
      };
    });
  }

  async sumForWallet(walletId: string): Promise<{ balanceMinor: bigint; entries: number }> {
    const [row] = await this.em.execute<SqlRow[]>(
      `SELECT coalesce(sum(${SIGNED_AMOUNT}), 0) AS balance, count(*) AS entries
         FROM ledger_entries WHERE account_type = 'WALLET' AND wallet_id = ?`,
      [walletId],
    );
    return { balanceMinor: asBigInt(row?.balance ?? 0), entries: asNumber(row?.entries ?? 0) };
  }
}
