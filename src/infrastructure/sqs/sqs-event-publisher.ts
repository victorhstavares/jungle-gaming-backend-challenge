import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes to a FIFO queue grouped by aggregate. The event id doubles as the deduplication id, so SQS drops
 * a republish within its 5-minute window; consumers still deduplicate by event id for anything later.
 * Sends go out ten per request because SQS throughput is bounded by the number of requests.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>> {
    const failures = new Map<string, string>();
    const chunks: OutboxMessage[][] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      chunks.push(messages.slice(start, start + SQS_BATCH_LIMIT));
    }

    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const out = await this.sqs.send(
            new SendMessageBatchCommand({
              QueueUrl: this.queueUrl,
              Entries: chunk.map((message, index) => ({
                Id: `e${String(index)}`,
                MessageBody: JSON.stringify(message.payload),
                MessageGroupId: message.aggregateId,
                MessageDeduplicationId: message.id,
                MessageAttributes: {
                  eventType: { DataType: 'String', StringValue: message.eventType },
                  eventId: { DataType: 'String', StringValue: message.id },
                },
              })),
            }),
          );
          for (const failed of out.Failed ?? []) {
            const message = chunk[Number(failed.Id?.slice(1))];
            if (message !== undefined) failures.set(message.id, failed.Message ?? failed.Code ?? 'rejected by SQS');
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          for (const message of chunk) failures.set(message.id, reason);
        }
      }),
    );
    return failures;
  }
}
