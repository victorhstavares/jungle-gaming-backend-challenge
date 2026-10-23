import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher, FaultInjector } from '../ports/messaging';
import type { Logger, Metrics } from '../ports/observability';
import type { TransactionRunner } from '../ports/repositories';

export interface OutboxOptions {
  batchSize: number;
  /** How long a claim keeps other publishers away; after it expires, a dead publisher's batch is taken over. */
  leaseMs: number;
}

const CTX = { correlationId: 'outbox-publisher' };

/**
 * Relays committed events to the broker. Claiming happens in its own short transaction (SKIP LOCKED plus a lease),
 * so many publishers can run at once and none holds a database lock while it talks to SQS.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    private readonly options: OutboxOptions,
  ) {}

  async execute(): Promise<{ published: number; failed: number }> {
    const claimed = await this.runner.run(CTX, (repos) =>
      repos.outbox.claim(this.clock.now(), this.options.batchSize, this.options.leaseMs),
    );

    const byAggregate = new Map<string, OutboxMessage[]>();
    for (const message of claimed) {
      byAggregate.set(message.aggregateId, [...(byAggregate.get(message.aggregateId) ?? []), message]);
    }
    const outcomes = await Promise.all(
      [...byAggregate.values()].map(async (messages) => {
        let published = 0;
        let failed = 0;
        for (const message of messages) {
          if (await this.publishOne(message)) published += 1;
          else failed += 1;
        }
        return { published, failed };
      }),
    );

    await this.updateLag();
    return outcomes.reduce((total, o) => ({ published: total.published + o.published, failed: total.failed + o.failed }), {
      published: 0,
      failed: 0,
    });
  }

  private async publishOne(message: OutboxMessage): Promise<boolean> {
    try {
      await this.publisher.publish(message);
    } catch (error) {
      message.scheduleRetry(this.clock.now());
      this.metrics.increment('outbox_publish_failures_total');
      this.logger.warn(
        { err: error, eventId: message.id, eventType: message.eventType, attempts: message.attempts },
        'outbox publish failed, will retry',
      );
      try {
        await this.runner.run(CTX, (repos) =>
          repos.outbox.recordFailure(message, error instanceof Error ? error.message : String(error)),
        );
      } catch (recordError) {
        // The lease expires on its own, so the message is retried even if this bookkeeping is lost.
        this.logger.error({ err: recordError, eventId: message.id }, 'could not record outbox failure');
      }
      return false;
    }

    this.faults.at('outbox.afterPublishBeforeMark');
    message.markPublished(this.clock.now());
    try {
      await this.runner.run(CTX, (repos) => repos.outbox.markPublished(message));
    } catch (error) {
      // Already on the broker; it will be published again after the lease and deduplicated downstream.
      this.logger.error({ err: error, eventId: message.id }, 'published event could not be marked');
    }
    this.metrics.increment('outbox_published_total');
    return true;
  }

  private async updateLag(): Promise<void> {
    try {
      const oldest = await this.runner.run(CTX, (repos) => repos.outbox.oldestPendingOccurredAt());
      const lag = oldest === undefined ? 0 : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
      this.metrics.setGauge('outbox_lag_seconds', lag);
    } catch (error) {
      this.logger.warn({ err: error }, 'could not measure outbox lag');
    }
  }
}
