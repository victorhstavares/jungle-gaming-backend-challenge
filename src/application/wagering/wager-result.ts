import type { MoneyProps } from '../../domain/money/money';
import { WagerTransactionStatus } from '../../domain/wagering/wager-kind';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export type WagerOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED' | 'DUPLICATE_MESSAGE';

export interface WagerResult {
  outcome: WagerOutcome;
  transactionId?: string;
  status?: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

const OUTCOME_BY_STATUS: Record<WagerTransactionStatus, WagerOutcome> = {
  [WagerTransactionStatus.Pending]: 'PENDING_REFERENCE',
  [WagerTransactionStatus.PendingReference]: 'PENDING_REFERENCE',
  [WagerTransactionStatus.Processed]: 'PROCESSED',
  [WagerTransactionStatus.Rejected]: 'REJECTED',
  [WagerTransactionStatus.Failed]: 'FAILED',
};

/** Built only from persisted fields, so a replay returns the same fields as the original answer. */
export function resultOf(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    outcome: OUTCOME_BY_STATUS[tx.status],
    transactionId: tx.id,
    status: tx.status,
    ...(tx.resultBalance === undefined ? {} : { balance: tx.resultBalance.toJSON() }),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    idempotentReplay,
  };
}
