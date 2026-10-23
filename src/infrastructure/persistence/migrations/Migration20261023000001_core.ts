import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000001Core extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id            uuid        PRIMARY KEY,
        player_id     uuid        NOT NULL,
        currency      char(3)     NOT NULL CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        balance_minor bigint      NOT NULL CONSTRAINT wallets_balance_non_negative CHECK (balance_minor >= 0),
        version       integer     NOT NULL CONSTRAINT wallets_version_positive CHECK (version >= 1),
        created_at    timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid         PRIMARY KEY,
        provider_id                       varchar(128) NOT NULL,
        external_transaction_id           varchar(128) NOT NULL,
        idempotency_key                   varchar(256) NOT NULL,
        payload_hash                      char(64)     NOT NULL CONSTRAINT wager_tx_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid         NOT NULL REFERENCES wallets (id),
        player_id                         uuid         NOT NULL,
        round_id                          varchar(128) NOT NULL,
        game_id                           varchar(128) NOT NULL,
        kind                              varchar(16)  NOT NULL CONSTRAINT wager_tx_kind_valid
                                            CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount_minor                      bigint       NOT NULL,
        currency                          char(3)      NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid         REFERENCES wager_transactions (id),
        status                            varchar(24)  NOT NULL CONSTRAINT wager_tx_status_valid
                                            CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      varchar(64),
        result_balance_minor              bigint,
        attempts                          integer      NOT NULL DEFAULT 0 CONSTRAINT wager_tx_attempts_non_negative CHECK (attempts >= 0),
        next_attempt_at                   timestamptz,
        created_at                        timestamptz  NOT NULL,
        updated_at                        timestamptz  NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_amount_positive CHECK (amount_minor > 0 OR (kind = 'LOSS' AND amount_minor = 0)),
        CONSTRAINT wager_tx_reversal_has_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_matches_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_has_timestamp CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )`);

    // A target can be reversed once in total: REFUND then ROLLBACK of the same BET would credit it twice.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_idx ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE TABLE ledger_entries (
        id                   uuid         PRIMARY KEY,
        seq                  bigint       GENERATED ALWAYS AS IDENTITY UNIQUE,
        transaction_id       uuid         NOT NULL REFERENCES wager_transactions (id),
        account_type         varchar(24)  NOT NULL CONSTRAINT ledger_account_type_valid
                               CHECK (account_type IN ('WALLET', 'PROVIDER_CLEARING', 'SYSTEM_OPENING')),
        account_id           varchar(160) NOT NULL,
        wallet_id            uuid         REFERENCES wallets (id),
        direction            varchar(6)   NOT NULL CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount_minor         bigint       NOT NULL CONSTRAINT ledger_amount_positive CHECK (amount_minor > 0),
        currency             char(3)      NOT NULL,
        balance_before_minor bigint,
        balance_after_minor  bigint,
        wallet_version       integer,
        created_at           timestamptz  NOT NULL,
        CONSTRAINT ledger_tx_account_key UNIQUE (transaction_id, account_type, account_id),
        CONSTRAINT ledger_wallet_version_key UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_wallet_columns CHECK (
          account_type <> 'WALLET'
          OR (wallet_id IS NOT NULL AND balance_before_minor IS NOT NULL
              AND balance_after_minor IS NOT NULL AND wallet_version IS NOT NULL)),
        CONSTRAINT ledger_counterpart_columns CHECK (
          account_type = 'WALLET'
          OR (wallet_id IS NULL AND balance_before_minor IS NULL
              AND balance_after_minor IS NULL AND wallet_version IS NULL)),
        CONSTRAINT ledger_wallet_account_matches CHECK (account_type <> 'WALLET' OR account_id = wallet_id::text),
        CONSTRAINT ledger_wallet_arithmetic CHECK (
          account_type <> 'WALLET'
          OR balance_after_minor = balance_before_minor + CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END),
        CONSTRAINT ledger_wallet_non_negative
          CHECK (account_type <> 'WALLET' OR (balance_before_minor >= 0 AND balance_after_minor >= 0))
      )`);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON ledger_entries (wallet_id, seq) WHERE account_type = 'WALLET'`);
    this.addSql(`CREATE INDEX ledger_transaction_idx ON ledger_entries (transaction_id)`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(64)  NOT NULL,
        message_id    varchar(128) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    uuid        NOT NULL,
        event_type      varchar(64) NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0 CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        locked_until    timestamptz,
        published_at    timestamptz,
        last_error      varchar(500)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
