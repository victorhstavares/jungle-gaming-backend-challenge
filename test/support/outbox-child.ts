/** Publishes one outbox batch in its own process; with FAULT_INJECTION armed it dies after publishing, before marking. */
import { PublishOutboxBatch } from '../../src/application/outbox/publish-outbox-batch';
import type { FaultPoint } from '../../src/application/ports/messaging';
import { ProcessExitFaultInjector } from '../../src/infrastructure/fault/fault-injector';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { SystemClock } from '../../src/infrastructure/system';
import { RecordingLogger, RecordingMetrics } from './observability';
import { openOrm, runnerFor } from './orm';
import { sqs } from './sqs';

const databaseUrl = process.env.DATABASE_URL ?? '';
const eventsUrl = process.env.EVENTS_QUEUE_URL ?? '';
const armed = process.env.FAULT_INJECTION;

const orm = await openOrm(databaseUrl, 4);
const batch = new PublishOutboxBatch(
  runnerFor(orm),
  new SqsEventPublisher(sqs, eventsUrl),
  new SystemClock(),
  new RecordingLogger(),
  new RecordingMetrics(),
  new ProcessExitFaultInjector(armed === undefined ? undefined : (armed as FaultPoint)),
  { batchSize: 50, leaseMs: 1_000 },
);
await batch.execute();
await orm.close(true);
process.exit(0);
