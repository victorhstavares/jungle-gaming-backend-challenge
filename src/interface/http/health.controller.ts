import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/config';
import { TOKENS } from '../../composition/tokens';
import type { PrometheusMetrics } from '../../infrastructure/observability/metrics';
import { Public } from './auth.guard';

const CHECK_TIMEOUT_MS = 2_000;

async function within(ms: number, check: () => Promise<unknown>): Promise<'up' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => {
      resolve('down');
    }, ms);
  });
  try {
    return await Promise.race([check().then(() => 'up' as const), timeout]);
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.metrics) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<{ status: string; checks: Record<string, string> }> {
    const [postgres, sqs] = await Promise.all([
      within(CHECK_TIMEOUT_MS, () => this.orm.em.fork().execute('SELECT 1')),
      within(CHECK_TIMEOUT_MS, () =>
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: this.config.wagerQueueUrl, AttributeNames: ['QueueArn'] }),
        ),
      ),
    ]);
    const healthy = postgres === 'up' && sqs === 'up';
    void reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  async metricsText(@Res() reply: FastifyReply): Promise<void> {
    await reply.header('content-type', this.metrics.contentType).send(await this.metrics.render());
  }
}
