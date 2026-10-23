import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { correlationIdFrom, runWithCorrelation } from '../../../src/infrastructure/observability/correlation';
import { createLogger, PinoLogger } from '../../../src/infrastructure/observability/logger';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/metrics';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger', () => {
  test('writes JSON lines and redacts secrets and payloads', () => {
    const out = capture();
    const logger = new PinoLogger(createLogger({ level: 'info', destination: out.stream }));

    logger.info(
      { req: { headers: { authorization: 'Bearer secret-token' } }, clientSecret: 's3cr3t', payload: { amount: '10.00' }, walletId: 'w-1' },
      'hello',
    );

    const [line] = out.lines();
    expect(line?.msg).toBe('hello');
    expect(line?.walletId).toBe('w-1');
    expect(JSON.stringify(line)).not.toContain('secret-token');
    expect(JSON.stringify(line)).not.toContain('s3cr3t');
    expect(JSON.stringify(line)).not.toContain('10.00');
  });

  test('adds the correlation id of the current async context', async () => {
    const out = capture();
    const logger = new PinoLogger(createLogger({ level: 'info', destination: out.stream }));

    await runWithCorrelation('corr-123', async () => {
      await Bun.sleep(1);
      logger.warn({}, 'inside');
    });
    logger.error({}, 'outside');

    const [inside, outside] = out.lines();
    expect(inside?.correlationId).toBe('corr-123');
    expect(outside?.correlationId).toBeUndefined();
  });
});

describe('correlation ids', () => {
  test('accepts a well formed header and replaces anything else', () => {
    expect(correlationIdFrom('abc-123')).toBe('abc-123');
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom('bad id with spaces')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom('x'.repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('metrics', () => {
  test('exposes counters, histograms and gauges in Prometheus text format', async () => {
    const metrics = new PrometheusMetrics();
    metrics.increment('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    metrics.observe('wager_processing_seconds', 0.012, { source: 'HTTP' });
    metrics.setGauge('outbox_lag_seconds', 3);

    const text = await metrics.render();
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 2');
    expect(text).toContain('wager_processing_seconds_count{source="HTTP"} 1');
    expect(text).toContain('outbox_lag_seconds 3');
    expect(metrics.contentType).toContain('text/plain');
  });
});
