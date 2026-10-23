import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { TransactionNotFoundError } from '../errors';
import type { TransactionRunner } from '../ports/repositories';

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  resultBalance?: MoneyProps;
  attempts: number;
  createdAt: string;
  processedAt?: string;
}

export const toTransactionView = (tx: WagerTransaction): TransactionView => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  status: tx.status,
  money: tx.money.toJSON(),
  ...(tx.referenceExternalTransactionId === undefined
    ? {}
    : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
  ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
  ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
  ...(tx.resultBalance === undefined ? {} : { resultBalance: tx.resultBalance.toJSON() }),
  attempts: tx.attempts,
  createdAt: tx.createdAt.toISOString(),
  ...(tx.processedAt === undefined ? {} : { processedAt: tx.processedAt.toISOString() }),
});

export class WagerQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.runner.run({ correlationId: 'query' }, (repos) => repos.transactions.findById(transactionId));
    if (tx === undefined) throw new TransactionNotFoundError(`Transaction ${transactionId} does not exist`);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.runner.run({ correlationId: 'query' }, (repos) =>
      repos.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (tx === undefined) {
      throw new TransactionNotFoundError(`Transaction ${providerId}/${externalTransactionId} does not exist`);
    }
    return toTransactionView(tx);
  }
}
