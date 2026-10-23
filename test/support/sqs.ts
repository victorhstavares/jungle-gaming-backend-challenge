import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

export const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566' });

export interface TestQueues {
  wagerUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  send: (body: string, groupId: string, dedupId?: string) => Promise<void>;
  drain: (url: string, waitSeconds?: number) => Promise<Message[]>;
  destroy: () => Promise<void>;
}

/** Fresh FIFO queues per test file so assertions on queue contents never see another file's messages. */
export async function createTestQueues(options: { maxReceiveCount?: number; visibilityTimeout?: number } = {}): Promise<TestQueues> {
  const prefix = `t${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-dlq.fifo`, Attributes: fifo }));
  const dlqUrl = dlq.QueueUrl ?? '';
  const arn = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const wager = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${prefix}-wager.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(options.visibilityTimeout ?? 2),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn.Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 10),
        }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-events.fifo`, Attributes: fifo }));
  const urls = { wagerUrl: wager.QueueUrl ?? '', dlqUrl, eventsUrl: events.QueueUrl ?? '' };

  return {
    ...urls,
    send: async (body, groupId, dedupId) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.wagerUrl,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: dedupId ?? Bun.randomUUIDv7(),
        }),
      );
    },
    drain: async (url, waitSeconds = 1) => {
      const all: Message[] = [];
      for (;;) {
        const out = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: waitSeconds,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['All'],
          }),
        );
        const batch = out.Messages ?? [];
        if (batch.length === 0) return all;
        for (const message of batch) {
          all.push(message);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
        }
      }
    },
    destroy: async () => {
      for (const url of Object.values(urls)) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
    },
  };
}

export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${Bun.randomUUIDv7()}`): string {
  return JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
}
