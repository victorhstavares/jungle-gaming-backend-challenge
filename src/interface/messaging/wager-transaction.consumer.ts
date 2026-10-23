import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { AuditRecorder } from '../../application/audit/audit-recorder';
import {
  ContractError,
  IdempotencyConflictError,
  InboxConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors';
import type { Clock } from '../../application/ports/clock';
import type { FaultInjector } from '../../application/ports/messaging';
import type { Logger, Metrics } from '../../application/ports/observability';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { parseWagerCommand, type WagerCommand } from '../../application/wagering/wager-command';
import { sha256Hex } from '../../domain/shared/canonical-json';
import { runWithCorrelation } from '../../infrastructure/observability/correlation';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export interface ConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  /** Receives after which a retryable message is parked in the DLQ by us, with its reason. */
  maxReceives: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
  shutdownGraceMs: number;
}

export interface ConsumerDeps {
  processWager: ProcessWagerTransaction;
  audit: AuditRecorder;
  supportedCurrencies: ReadonlySet<string>;
  logger: Logger;
  metrics: Metrics;
  faults: FaultInjector;
  clock: Clock;
}

const envelopeSchema = z.object({
  messageId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

type Verdict =
  | { action: 'ack' }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string; code: string; command?: WagerCommand; messageId?: string };

/**
 * Reads wager requests from SQS and hands them to the same use case as the HTTP API. A message is deleted only
 * after its transaction committed; until then SQS redelivers it and the inbox turns the redelivery into a no-op.
 */
export class WagerTransactionConsumer {
  private stopping = false;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: ConsumerOptions,
    private readonly deps: ConsumerDeps,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops polling, lets in-flight messages finish within the grace period, and hands unstarted ones back to SQS. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.loop === undefined) return;
    await Promise.race([this.loop, Bun.sleep(this.options.shutdownGraceMs)]);
  }

  async pollOnce(): Promise<number> {
    const out = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = out.Messages ?? [];

    // FIFO order matters only inside a message group, so groups run in parallel and each group runs in order.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        let blocked = false;
        for (const message of group) {
          // Once a message goes back for retry, the rest of its group must wait behind it to keep FIFO order.
          if (blocked || this.isStopping()) {
            await this.release(message);
            continue;
          }
          blocked = (await this.handle(message)) === 'retry';
        }
      }),
    );
    return messages.length;
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.isStopping()) return;
        this.deps.logger.error({ err: error, queueUrl: this.options.queueUrl }, 'queue poll failed');
        await Bun.sleep(1_000);
      }
    }
  }

  private async handle(message: Message): Promise<'settled' | 'retry'> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const verdict = await this.process(message);

    if (verdict.action === 'ack') {
      await this.delete(message);
      return 'settled';
    }
    if (verdict.action === 'dlq') {
      await this.deadLetter(message, verdict);
      return 'settled';
    }
    if (receiveCount >= this.options.maxReceives) {
      await this.deadLetter(message, { action: 'dlq', reason: verdict.reason, code: verdict.reason });
      return 'settled';
    }
    this.deps.metrics.increment('sqs_retries_total', { reason: verdict.reason });
    const delay = Math.min(this.options.baseBackoffSeconds * 2 ** receiveCount, this.options.maxBackoffSeconds);
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
    return 'retry';
  }

  private async process(message: Message): Promise<Verdict> {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(message.Body ?? ''));
    } catch {
      return { action: 'dlq', reason: 'INVALID_PAYLOAD', code: 'INVALID_PAYLOAD' };
    }

    return runWithCorrelation(envelope.messageId, async (): Promise<Verdict> => {
      const { idempotencyKey, ...wager } = envelope.data;
      let command: WagerCommand;
      try {
        command = parseWagerCommand(
          wager,
          typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
          this.deps.supportedCurrencies,
        );
      } catch (error) {
        if (error instanceof ContractError) {
          return { action: 'dlq', reason: 'INVALID_PAYLOAD', code: error.code, messageId: envelope.messageId };
        }
        throw error;
      }

      try {
        await this.deps.processWager.execute(command, {
          source: 'SQS',
          actor: WAGER_CONSUMER_NAME,
          correlationId: envelope.messageId,
          inbox: {
            consumerName: WAGER_CONSUMER_NAME,
            messageId: envelope.messageId,
            payloadHash: sha256Hex(`${command.idempotencyKey}:${command.payloadHash}`),
          },
        });
        this.deps.faults.at('consumer.afterCommitBeforeAck');
        return { action: 'ack' };
      } catch (error) {
        return this.classify(error, command, envelope.messageId);
      }
    });
  }

  private classify(error: unknown, command: WagerCommand, messageId: string): Verdict {
    if (error instanceof IdempotencyConflictError) {
      return { action: 'dlq', reason: error.code, code: error.code, command, messageId };
    }
    if (error instanceof InboxConflictError) {
      return { action: 'dlq', reason: error.code, code: error.code, command, messageId };
    }
    // The wallet may be created moments after the first bet is queued; give it a few redeliveries.
    if (error instanceof WalletNotFoundError) return { action: 'retry', reason: error.code };
    if (error instanceof TransientInfrastructureError) return { action: 'retry', reason: error.reason.toUpperCase() };
    this.deps.logger.error({ err: error, messageId }, 'unexpected error while consuming a wager message');
    return { action: 'retry', reason: 'UNEXPECTED' };
  }

  private async deadLetter(message: Message, verdict: Extract<Verdict, { action: 'dlq' }>): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId ?? Bun.randomUUIDv7(),
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: verdict.reason },
          code: { DataType: 'String', StringValue: verdict.code },
        },
      }),
    );
    await this.delete(message);
    this.deps.metrics.increment('sqs_dlq_total', { reason: verdict.reason });
    this.deps.logger.warn(
      { messageId: verdict.messageId, sqsMessageId: message.MessageId, reason: verdict.reason, code: verdict.code },
      'message moved to the dead-letter queue',
    );
    const cmd = verdict.command;
    await this.deps.audit.recordOutside({
      source: 'SQS',
      actor: WAGER_CONSUMER_NAME,
      operation: 'SUBMIT_WAGER',
      outcome: 'DLQ',
      code: verdict.code,
      correlationId: verdict.messageId ?? message.MessageId ?? 'unknown',
      occurredAt: this.deps.clock.now(),
      ...(verdict.messageId === undefined ? {} : { messageId: verdict.messageId }),
      ...(cmd === undefined
        ? {}
        : { idempotencyKey: cmd.idempotencyKey, payloadHash: cmd.payloadHash, walletId: cmd.walletId }),
    });
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(message: Message): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }
}
