import { Migration } from '@mikro-orm/migrations';

/** Orders the outbox by a database sequence instead of application timestamps, which can skew between hosts. */
export class Migration20261023000005OutboxSequence extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY`);
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
