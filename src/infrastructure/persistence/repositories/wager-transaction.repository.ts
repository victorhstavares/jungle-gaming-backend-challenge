import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../../application/ports/repositories';
import { Money } from '../../../domain/money/money';
import { FailureCode } from '../../../domain/wagering/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-kind';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionRecord, type WagerTransactionRow } from '../records';
import { asEnum, asString } from '../sql-values';

const toDomain = (row: WagerTransactionRow): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: asEnum(WagerTransactionKind, row.kind),
    money: Money.ofMinor(row.amountMinor, row.currency),
    createdAt: row.createdAt,
    status: asEnum(WagerTransactionStatus, row.status),
    attempts: row.attempts,
    ...(row.referenceExternalTransactionId == null
      ? {}
      : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
    ...(row.referenceTransactionId == null ? {} : { referenceTransactionId: row.referenceTransactionId }),
    ...(row.failureCode == null ? {} : { failureCode: asEnum(FailureCode, row.failureCode) }),
    ...(row.processedAt == null ? {} : { processedAt: row.processedAt }),
    ...(row.resultBalanceMinor == null ? {} : { resultBalance: Money.ofMinor(row.resultBalanceMinor, row.currency) }),
    ...(row.nextAttemptAt == null ? {} : { nextAttemptAt: row.nextAttemptAt }),
  });

const mutableColumns = (tx: WagerTransaction, now: Date) => ({
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  resultBalanceMinor: tx.resultBalance?.toMinor() ?? null,
  attempts: tx.attempts,
  nextAttemptAt: tx.nextAttemptAt ?? null,
  processedAt: tx.processedAt ?? null,
  updatedAt: now,
});

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? undefined : toDomain(row);
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amountMinor: tx.money.toMinor(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      createdAt: tx.createdAt,
      ...mutableColumns(tx, tx.createdAt),
    });
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(WagerTransactionRecord, { id: tx.id }, mutableColumns(tx, new Date()));
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextAttemptAt: { $gt: now },
      },
      { nextAttemptAt: now, updatedAt: now },
    );
  }

  async claimPendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]> {
    const rows = await this.em.execute<{ id: unknown }[]>(
      `UPDATE wager_transactions SET next_attempt_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
           ORDER BY next_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map((row) => asString(row.id));
  }

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return row === null ? undefined : toDomain(row);
  }
}
