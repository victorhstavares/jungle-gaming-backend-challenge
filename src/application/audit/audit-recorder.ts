import type { AuditEntry } from '../ports/audit';
import type { Logger, Metrics } from '../ports/observability';
import type { TransactionRunner } from '../ports/repositories';

/**
 * Writes audit rows for attempts whose main transaction rolled back. A failure here is logged and counted
 * but never replaces the original error: the caller's outcome must not depend on the audit trail being up.
 */
export class AuditRecorder {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async recordOutside(entry: AuditEntry): Promise<void> {
    try {
      await this.runner.run({ correlationId: entry.correlationId }, (repos) => repos.audit.record(entry));
    } catch (error) {
      this.metrics.increment('audit_write_failures_total');
      this.logger.error(
        {
          err: error,
          audit: {
            source: entry.source,
            operation: entry.operation,
            outcome: entry.outcome,
            code: entry.code,
            correlationId: entry.correlationId,
            messageId: entry.messageId,
            idempotencyKey: entry.idempotencyKey,
            transactionId: entry.transactionId,
            walletId: entry.walletId,
          },
        },
        'audit write failed',
      );
    }
  }
}
