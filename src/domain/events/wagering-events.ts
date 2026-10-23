import type { MoneyProps } from '../money/money';
import type { WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-kind';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  resultBalance?: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    ...(tx.resultBalance === undefined ? {} : { resultBalance: tx.resultBalance.toJSON() }),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
  };
}

/** Emitted for every applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: string;
}

/** Emitted for REJECTED and FAILED transactions; the status tells them apart. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), failureCode: tx.failureCode ?? 'UNKNOWN' },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), attempts: tx.attempts },
    });
  }
}
