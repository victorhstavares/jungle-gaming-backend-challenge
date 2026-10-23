import type { EventContext } from '../domain/events/integration-event';
import type { IdGenerator } from './ports/clock';

/** Each event gets its own id; correlation and causation tie it back to the request or message that caused it. */
export function eventContextFactory(
  ids: IdGenerator,
  occurredAt: Date,
  correlationId: string,
  causationId?: string,
): () => EventContext {
  return () => ({
    eventId: ids.next(),
    correlationId,
    occurredAt,
    ...(causationId === undefined ? {} : { causationId }),
  });
}
