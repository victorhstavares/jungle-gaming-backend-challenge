import type { EntityManager } from '@mikro-orm/postgresql';
import type { AuditEntry } from '../../../application/ports/audit';
import type {
  AuditRepository,
  ReconciliationRepository,
  ReconciliationRun,
} from '../../../application/ports/repositories';

export class MikroOrmAuditRepository implements AuditRepository {
  constructor(private readonly em: EntityManager) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO audit_log (occurred_at, source, actor, operation, outcome, code, correlation_id, message_id,
         idempotency_key, payload_hash, payload, transaction_id, wallet_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
      [
        entry.occurredAt,
        entry.source,
        entry.actor,
        entry.operation,
        entry.outcome,
        entry.code ?? null,
        entry.correlationId,
        entry.messageId ?? null,
        entry.idempotencyKey ?? null,
        entry.payloadHash ?? null,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
        entry.transactionId ?? null,
        entry.walletId ?? null,
      ],
    );
  }
}

export class MikroOrmReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly em: EntityManager) {}

  async record(run: ReconciliationRun): Promise<void> {
    const stored = run.stored.toMinor();
    const calculated = run.calculated.toMinor();
    await this.em.execute(
      `INSERT INTO reconciliation_runs (id, wallet_id, actor, correlation_id, currency, stored_balance_minor,
         calculated_balance_minor, difference_minor, checked_entries, consistent, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.walletId,
        run.actor,
        run.correlationId,
        run.stored.currency,
        stored,
        calculated,
        stored - calculated,
        run.checkedEntries,
        stored === calculated,
        run.checkedAt,
      ],
    );
  }
}
