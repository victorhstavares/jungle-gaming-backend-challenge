import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000003Audit extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transaction_status_history (
        id             bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        transaction_id uuid         NOT NULL REFERENCES wager_transactions (id),
        from_status    varchar(24),
        to_status      varchar(24)  NOT NULL,
        failure_code   varchar(64),
        attempt        integer      NOT NULL,
        correlation_id varchar(64),
        changed_at     timestamptz  NOT NULL
      )`);
    this.addSql(`CREATE INDEX status_history_transaction_idx ON wager_transaction_status_history (transaction_id, id)`);

    // Written by the database itself, so no code path can change a status without leaving a row here.
    this.addSql(`
      CREATE FUNCTION record_wager_status() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO wager_transaction_status_history
          (transaction_id, from_status, to_status, failure_code, attempt, correlation_id, changed_at)
        VALUES (
          NEW.id,
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
          NEW.status,
          NEW.failure_code,
          NEW.attempts,
          nullif(current_setting('app.correlation_id', true), ''),
          clock_timestamp());
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_status_insert AFTER INSERT ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION record_wager_status()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_status_update AFTER UPDATE ON wager_transactions
        FOR EACH ROW
        WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.attempts IS DISTINCT FROM NEW.attempts)
        EXECUTE FUNCTION record_wager_status()`);

    this.addSql(`
      CREATE TABLE audit_log (
        id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        occurred_at     timestamptz  NOT NULL,
        source          varchar(8)   NOT NULL CONSTRAINT audit_source_valid CHECK (source IN ('HTTP', 'SQS', 'WORKER')),
        actor           varchar(128) NOT NULL,
        operation       varchar(32)  NOT NULL CONSTRAINT audit_operation_valid
                          CHECK (operation IN ('OPEN_WALLET', 'SUBMIT_WAGER', 'RETRY_PENDING_REFERENCE', 'RECONCILE')),
        outcome         varchar(24)  NOT NULL CONSTRAINT audit_outcome_valid
                          CHECK (outcome IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'REPLAY', 'IDEMPOTENCY_CONFLICT',
                                             'CONTRACT_ERROR', 'DLQ', 'FAILED', 'NOT_FOUND', 'DUPLICATE_MESSAGE')),
        code            varchar(64),
        correlation_id  varchar(64)  NOT NULL,
        message_id      varchar(128),
        idempotency_key varchar(256),
        payload_hash    char(64),
        payload         jsonb,
        transaction_id  uuid,
        wallet_id       uuid
      )`);
    this.addSql(`CREATE INDEX audit_correlation_idx ON audit_log (correlation_id)`);
    this.addSql(`CREATE INDEX audit_source_time_idx ON audit_log (source, occurred_at)`);
    this.addSql(`CREATE INDEX audit_idempotency_idx ON audit_log (idempotency_key) WHERE idempotency_key IS NOT NULL`);
    this.addSql(`CREATE INDEX audit_transaction_idx ON audit_log (transaction_id) WHERE transaction_id IS NOT NULL`);

    this.addSql(`
      CREATE TABLE reconciliation_runs (
        id                       uuid         PRIMARY KEY,
        wallet_id                uuid         NOT NULL REFERENCES wallets (id),
        actor                    varchar(128) NOT NULL,
        correlation_id           varchar(64)  NOT NULL,
        currency                 char(3)      NOT NULL,
        stored_balance_minor     bigint       NOT NULL,
        calculated_balance_minor bigint       NOT NULL,
        difference_minor         bigint       NOT NULL,
        checked_entries          integer      NOT NULL CONSTRAINT reconciliation_entries_non_negative CHECK (checked_entries >= 0),
        consistent               boolean      NOT NULL,
        checked_at               timestamptz  NOT NULL,
        CONSTRAINT reconciliation_difference_matches
          CHECK (difference_minor = stored_balance_minor - calculated_balance_minor),
        CONSTRAINT reconciliation_consistency_matches CHECK (consistent = (difference_minor = 0))
      )`);
    this.addSql(`CREATE INDEX reconciliation_wallet_idx ON reconciliation_runs (wallet_id, checked_at)`);

    for (const table of ['wager_transaction_status_history', 'audit_log', 'reconciliation_runs']) {
      this.addSql(`
        CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
      this.addSql(`
        CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);
    }
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS reconciliation_runs');
    this.addSql('DROP TABLE IF EXISTS audit_log');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_status_update ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_status_insert ON wager_transactions');
    this.addSql('DROP FUNCTION IF EXISTS record_wager_status()');
    this.addSql('DROP TABLE IF EXISTS wager_transaction_status_history');
  }
}
