import type { MoneyProps } from '../../domain/money/money';
import { ContractError, InvalidCursorError, WalletNotFoundError } from '../errors';
import type { TransactionRunner } from '../ports/repositories';
import { toWalletView, type WalletView } from './wallet-view';

export interface LedgerItemView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItemView[];
  nextCursor: string | null;
}

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;
const MAX_SEQ = 9_223_372_036_854_775_807n;

/** The cursor is the base64url of the last seen ledger sequence: opaque to clients, stable under new inserts. */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(seq.toString(), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): bigint {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cursor)) throw new InvalidCursorError('Malformed cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[1-9][0-9]{0,18}$/.test(decoded)) throw new InvalidCursorError('Malformed cursor');
  const seq = BigInt(decoded);
  if (seq > MAX_SEQ) throw new InvalidCursorError('Malformed cursor');
  return seq;
}

export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.runner.run({ correlationId: 'query' }, (repos) => repos.wallets.findById(walletId));
    if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${walletId} does not exist`);
    return toWalletView(wallet);
  }

  async listLedger(walletId: string, cursor: string | undefined, limit = LEDGER_DEFAULT_LIMIT): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new ContractError('INVALID_PAYLOAD', `limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`, [
        { path: 'limit', message: 'out of range' },
      ]);
    }
    const afterSeq = cursor === undefined ? undefined : decodeCursor(cursor);

    return this.runner.run({ correlationId: 'query' }, async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${walletId} does not exist`);

      const rows = await repos.ledger.page(walletId, afterSeq, limit + 1);
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(({ entry }) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.seq) : null,
      };
    });
  }
}
