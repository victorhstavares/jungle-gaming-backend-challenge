import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository, OutboxRepository } from '../../../application/ports/repositories';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { asDate, asNumber, asOptionalDate, asRecord, asString, type SqlRow } from '../sql-values';

const MAX_ERROR_LENGTH = 500;

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<SqlRow[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async payloadHashOf(consumerName: string, messageId: string): Promise<string | undefined> {
    const [row] = await this.em.execute<SqlRow[]>(INBOX_HASH_QUERY, [consumerName, messageId]);
    return row === undefined ? undefined : asString(row.payload_hash);
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`,
      [message.processedAt ?? new Date(), message.consumerName, message.messageId],
    );
  }
}

const INBOX_HASH_QUERY = `SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`;

const toOutbox = (row: SqlRow): OutboxMessage => {
  const nextAttemptAt = asOptionalDate(row.next_attempt_at);
  const publishedAt = asOptionalDate(row.published_at);
  return OutboxMessage.rehydrate({
    id: asString(row.id),
    aggregateId: asString(row.aggregate_id),
    eventType: asString(row.event_type),
    payload: asRecord(row.payload),
    occurredAt: asDate(row.occurred_at),
    attempts: asNumber(row.attempts),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  });
};

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const placeholders = messages.map(() => '(?, ?, ?, ?::jsonb, ?, ?, ?)').join(', ');
    const params = messages.flatMap((m) => [
      m.id,
      m.aggregateId,
      m.eventType,
      JSON.stringify(m.payload),
      m.occurredAt,
      m.attempts,
      m.nextAttemptAt ?? m.occurredAt,
    ]);
    await this.em.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ${placeholders}`,
      params,
    );
  }

  async claim(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<SqlRow[]>(
      `UPDATE outbox_messages SET locked_until = ?
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY occurred_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at`,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map(toOutbox).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.execute(`UPDATE outbox_messages SET published_at = ?, locked_until = NULL WHERE id = ?`, [
      message.publishedAt ?? new Date(),
      message.id,
    ]);
  }

  async recordFailure(message: OutboxMessage, error: string): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ?, locked_until = NULL WHERE id = ?`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error.slice(0, MAX_ERROR_LENGTH), message.id],
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<SqlRow[]>(
      `SELECT min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    return asOptionalDate(row?.oldest);
  }
}
