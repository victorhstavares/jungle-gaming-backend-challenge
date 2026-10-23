import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AuditRecorder } from '../../application/audit/audit-recorder';
import { PublishOutboxBatch } from '../../application/outbox/publish-outbox-batch';
import { RetryPendingReferences } from '../../application/pending/retry-pending-references';
import type { Clock } from '../../application/ports/clock';
import type { FaultInjector } from '../../application/ports/messaging';
import type { Logger, Metrics } from '../../application/ports/observability';
import type { TransactionRunner } from '../../application/ports/repositories';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { TOKENS } from '../../composition/tokens';
import type { AppConfig } from '../../config/config';
import { SqsEventPublisher } from '../../infrastructure/sqs/sqs-event-publisher';
import { WagerTransactionConsumer } from '../messaging/wager-transaction.consumer';
import { Poller } from './poller';

const IDLE_MS = 500;
const SHUTDOWN_GRACE_MS = 25_000;

/** Starts the queue consumer and the outbox and pending-reference workers that this process's roles ask for. */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: WagerTransactionConsumer | undefined;
  private readonly pollers: Poller[] = [];

  constructor(
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
    @Inject(TOKENS.runner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.processWager) private readonly processWager: ProcessWagerTransaction,
    @Inject(TOKENS.audit) private readonly audit: AuditRecorder,
    @Inject(TOKENS.clock) private readonly clock: Clock,
    @Inject(TOKENS.logger) private readonly logger: Logger,
    @Inject(TOKENS.metrics) private readonly metrics: Metrics,
    @Inject(TOKENS.faults) private readonly faults: FaultInjector,
  ) {}

  onApplicationBootstrap(): void {
    const { roles } = this.config;
    if (roles.has('consumer')) {
      this.consumer = new WagerTransactionConsumer(
        this.sqs,
        {
          queueUrl: this.config.wagerQueueUrl,
          dlqUrl: this.config.wagerDlqUrl,
          waitTimeSeconds: 20,
          visibilityTimeoutSeconds: 30,
          maxReceives: 10,
          baseBackoffSeconds: 1,
          maxBackoffSeconds: 60,
          shutdownGraceMs: SHUTDOWN_GRACE_MS,
        },
        {
          processWager: this.processWager,
          audit: this.audit,
          supportedCurrencies: this.config.supportedCurrencies,
          logger: this.logger,
          metrics: this.metrics,
          faults: this.faults,
          clock: this.clock,
        },
      );
      this.consumer.start();
    }
    if (roles.has('outbox')) {
      const outbox = new PublishOutboxBatch(
        this.runner,
        new SqsEventPublisher(this.sqs, this.config.eventsQueueUrl),
        this.clock,
        this.logger,
        this.metrics,
        this.faults,
        { batchSize: 50, leaseMs: 30_000 },
      );
      this.pollers.push(new Poller('outbox', async () => (await outbox.execute()).published, IDLE_MS, this.logger));
    }
    if (roles.has('pending-reference')) {
      const pending = new RetryPendingReferences(this.runner, this.processWager, this.clock, this.logger, this.metrics, {
        batchSize: 50,
        leaseMs: 30_000,
      });
      this.pollers.push(new Poller('pending-reference', () => pending.execute(), IDLE_MS, this.logger));
    }
    for (const poller of this.pollers) poller.start();
    this.logger.info({ roles: [...roles] }, 'background workers started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer?.stop(), ...this.pollers.map((poller) => poller.stop())]);
    this.logger.info({}, 'background workers stopped');
  }
}
