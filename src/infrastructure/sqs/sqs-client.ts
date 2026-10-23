import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.awsRegion,
    ...(config.sqsEndpoint === undefined ? {} : { endpoint: config.sqsEndpoint }),
    maxAttempts: 3,
    // Long polls wait up to 20s, so the request timeout leaves room for them; anything slower is a stuck call.
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 25_000 },
  });
}
