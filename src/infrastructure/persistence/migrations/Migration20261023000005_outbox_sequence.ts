import { Migration } from '@mikro-orm/migrations';

/** Orders the outbox by a database sequence instead of application timestamps, which can skew between hosts. */
export class Migration20261023000005OutboxSequence extends Migration {
  override up(): void {
    this.addSql('ALTER TABLE outbox_messages ADD COLUMN seq bigint');
    // An identity added in one step numbers rows in heap order, and a retried event has moved on disk. Numbering the
    // existing backlog by event order first keeps an older pending event ahead of newer ones from the same aggregate.
    this.addSql(`
      UPDATE outbox_messages o SET seq = ordered.rn
        FROM (SELECT id, row_number() OVER (ORDER BY occurred_at, id) AS rn FROM outbox_messages) ordered
       WHERE ordered.id = o.id`);
    this.addSql('ALTER TABLE outbox_messages ALTER COLUMN seq SET NOT NULL');
    this.addSql('ALTER TABLE outbox_messages ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY');
    this.addSql(`
      SELECT setval(pg_get_serial_sequence('outbox_messages', 'seq'), coalesce(max(seq), 0) + 1, false)
        FROM outbox_messages`);
    this.addSql('DROP INDEX IF EXISTS outbox_pending_aggregate_idx');
    this.addSql(`CREATE INDEX outbox_pending_aggregate_seq_idx ON outbox_messages (aggregate_id, seq) WHERE published_at IS NULL`);
    this.addSql(`CREATE INDEX outbox_pending_seq_idx ON outbox_messages (seq) WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP INDEX IF EXISTS outbox_pending_seq_idx');
    this.addSql('DROP INDEX IF EXISTS outbox_pending_aggregate_seq_idx');
    this.addSql(`CREATE INDEX outbox_pending_aggregate_idx ON outbox_messages (aggregate_id, occurred_at, id) WHERE published_at IS NULL`);
    this.addSql('ALTER TABLE outbox_messages DROP COLUMN seq');
  }
}
