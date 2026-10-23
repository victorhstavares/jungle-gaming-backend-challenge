import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/**
 * Publishes to a FIFO queue grouped by aggregate. The event id doubles as the deduplication id, so SQS drops
 * a republish within its 5-minute window; consumers still deduplicate by event id for anything later.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
          eventId: { DataType: 'String', StringValue: message.id },
        },
      }),
    );
  }
}
