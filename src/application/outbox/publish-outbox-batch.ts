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

    // The claim hands out at most one event per aggregate, so the whole batch can go out at once.
    const failures = await this.publisher.publishBatch(claimed);
    const published = claimed.filter((message) => !failures.has(message.id));
    const failed = claimed.filter((message) => failures.has(message.id));
    await Promise.all(failed.map((message) => this.recordFailure(message, failures.get(message.id) ?? 'unknown')));

    if (published.length > 0) {
      this.faults.at('outbox.afterPublishBeforeMark');
      await this.markPublished(published);
    }
    await this.updateLag();
    return { published: published.length, failed: failed.length };
  }

  /** One UPDATE for the whole batch keeps the publisher from competing with wagers for pooled connections. */
  private async markPublished(messages: readonly OutboxMessage[]): Promise<void> {
    const now = this.clock.now();
    for (const message of messages) message.markPublished(now);
    try {
      await this.runner.run(CTX, (repos) => repos.outbox.markPublished(messages));
      this.metrics.increment('outbox_published_total', {}, messages.length);
    } catch (error) {
      // Already on the broker; they will be published again after the lease and deduplicated downstream.
      this.logger.error({ err: error, events: messages.length }, 'published events could not be marked');
    }
  }

  private async recordFailure(message: OutboxMessage, reason: string): Promise<void> {
    message.scheduleRetry(this.clock.now());
    this.metrics.increment('outbox_publish_failures_total');
    this.logger.warn(
      { eventId: message.id, eventType: message.eventType, attempts: message.attempts, reason },
      'outbox publish failed, will retry',
    );
    try {
      await this.runner.run(CTX, (repos) => repos.outbox.recordFailure(message, reason));
    } catch (error) {
      // The lease expires on its own, so the message is retried even if this bookkeeping is lost.
      this.logger.error({ err: error, eventId: message.id }, 'could not record outbox failure');
    }
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
