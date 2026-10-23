import { defineEntity, p, type InferEntity } from '@mikro-orm/postgresql';

/** Persistence shapes, kept apart from the domain aggregates; repositories map between the two explicitly. */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balanceMinor: p.bigint(),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRow = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amountMinor: p.bigint(),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    resultBalanceMinor: p.bigint().nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;

export const PERSISTENCE_RECORDS = [WalletRecord, WagerTransactionRecord];
