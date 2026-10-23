import { IntegrityViolationError, UniqueViolationError } from '../errors';
import type { Clock } from '../ports/clock';
import type { Logger, Metrics } from '../ports/observability';
import type { TransactionRunner } from '../ports/repositories';
import type { ProcessWagerTransaction } from '../wagering/process-wager-transaction';

export interface PendingWorkerOptions {
  batchSize: number;
  leaseMs: number;
}

const ACTOR = 'pending-reference-worker';
const RETRY_CONCURRENCY = 4;

/**
 * Re-evaluates due PENDING_REFERENCE transactions. The claim commits before any reprocessing starts: holding the
 * claimed rows while waiting for a wallet lock would stall a writer that holds that wallet and wakes dependents.
 */
export class RetryPendingReferences {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: PendingWorkerOptions,
  ) {}

  async execute(): Promise<number> {
    const ids = await this.runner.run({ correlationId: 'pending-reference-claim' }, (repos) =>
      repos.transactions.claimPendingReferences(this.clock.now(), this.options.batchSize, this.options.leaseMs),
    );

    // A few at a time: a burst of wake-ups on one wallet would otherwise park every pooled connection on its lock.
    for (let start = 0; start < ids.length; start += RETRY_CONCURRENCY) {
      await this.retryChunk(ids.slice(start, start + RETRY_CONCURRENCY));
    }
    return ids.length;
  }

  private async retryChunk(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const ctx = { source: 'WORKER' as const, actor: ACTOR, correlationId: `retry-${id}` };
        try {
          await this.processWager.reprocessPending(id, ctx);
        } catch (error) {
          if (error instanceof IntegrityViolationError || error instanceof UniqueViolationError) {
            await this.processWager.failPending(id, ctx, error);
            return;
          }
          // Transient: the lease expires and the next run picks the row up again.
          this.metrics.increment('pending_reference_retries_total');
          this.logger.warn({ err: error, transactionId: id }, 'pending reference retry failed, will try again');
        }
      }),
    );
  }
}
