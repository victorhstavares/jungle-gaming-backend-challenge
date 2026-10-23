/**
 * Runs one consumer poll in its own process. With FAULT_INJECTION armed the process exits right after the
 * commit and before the ack, which is the crash the README asks to survive.
 */
import { ProcessExitFaultInjector } from '../../src/infrastructure/fault/fault-injector';
import { WagerTransactionConsumer } from '../../src/interface/messaging/wager-transaction.consumer';
import type { FaultPoint } from '../../src/application/ports/messaging';
import { openOrm } from './orm';
import { SUPPORTED, buildServices } from './services';
import { sqs } from './sqs';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
};

const orm = await openOrm(env('DATABASE_URL'), 4);
const services = buildServices(orm);
const armed = process.env.FAULT_INJECTION;
const consumer = new WagerTransactionConsumer(
  sqs,
  {
    queueUrl: env('WAGER_QUEUE_URL'),
    dlqUrl: env('WAGER_DLQ_URL'),
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 2,
    maxReceives: 10,
    baseBackoffSeconds: 1,
    maxBackoffSeconds: 2,
    shutdownGraceMs: 1_000,
  },
  {
    processWager: services.processWager,
    audit: services.audit,
    supportedCurrencies: SUPPORTED,
    logger: services.logger,
    metrics: services.metrics,
    faults: new ProcessExitFaultInjector(armed === undefined ? undefined : (armed as FaultPoint)),
    clock: services.clock,
  },
);

const handled = await consumer.pollOnce();
await orm.close(true);
process.stdout.write(`handled=${String(handled)}\n`);
process.exit(0);
