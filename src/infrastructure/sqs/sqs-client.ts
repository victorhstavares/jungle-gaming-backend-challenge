import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.awsRegion,
    ...(config.sqsEndpoint === undefined ? {} : { endpoint: config.sqsEndpoint }),
    maxAttempts: 3,
  });
}
