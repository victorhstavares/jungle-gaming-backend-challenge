import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface EventPublisher {
  /**
   * At-least-once: may deliver a message more than once; consumers deduplicate by event id.
   * Resolves with the ids that were not accepted, mapped to the reason.
   */
  publishBatch(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>>;
}

export type FaultPoint = 'consumer.afterCommitBeforeAck' | 'outbox.afterPublishBeforeMark';

/** Lets tests kill the process between a commit and its ack, or between a publish and its mark. No-op outside tests. */
export interface FaultInjector {
  at(point: FaultPoint): void;
}
