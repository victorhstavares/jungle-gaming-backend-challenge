import { Migration } from '@mikro-orm/migrations';

/**
 * Integrity rules the application must not be able to bypass. Every violation raises SQLSTATE P0001
 * with a message prefixed by "integrity:" so the error classifier can tell it apart from business errors.
 */
export class Migration20261023000002Integrity extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'integrity: % on % is not allowed, the table is append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'P0001';
      END $$`);

    this.addSql(`
      CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);

    this.addSql(`
      CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'integrity: transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'P0001';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount_minor, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount_minor, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'integrity: business fields of transaction % are immutable', OLD.id USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_update BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update()`);

    this.addSql(`
      CREATE FUNCTION guard_wallet_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'integrity: identity of wallet % is immutable', OLD.id USING ERRCODE = 'P0001';
        END IF;
        IF NEW.balance_minor <> OLD.balance_minor AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'integrity: wallet % balance changed without a single version bump', OLD.id
            USING ERRCODE = 'P0001';
        END IF;
        IF NEW.balance_minor = OLD.balance_minor AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'integrity: wallet % version changed without a balance change', OLD.id
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_update()`);

    // Deferred to commit so a transaction can update the wallet and insert its postings in any order.
    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_balance bigint;
        current_version integer;
        entry_after     bigint;
      BEGIN
        SELECT balance_minor, version INTO current_balance, current_version FROM wallets WHERE id = NEW.id;
        IF current_version = 1 AND current_balance = 0 THEN
          RETURN NULL;
        END IF;
        SELECT balance_after_minor INTO entry_after FROM ledger_entries
         WHERE account_type = 'WALLET' AND wallet_id = NEW.id AND wallet_version = current_version;
        IF entry_after IS DISTINCT FROM current_balance THEN
          RAISE EXCEPTION 'integrity: wallet % balance % at version % has no matching ledger entry',
            NEW.id, current_balance, current_version USING ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_match_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger()`);

    this.addSql(`
      CREATE FUNCTION assert_ledger_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        imbalance       bigint;
        expected_before bigint;
      BEGIN
        SELECT coalesce(sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0)
          INTO imbalance FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
        IF imbalance <> 0 THEN
          RAISE EXCEPTION 'integrity: postings of transaction % are unbalanced by %', NEW.transaction_id, imbalance
            USING ERRCODE = 'P0001';
        END IF;

        IF NEW.account_type = 'WALLET' THEN
          SELECT balance_after_minor INTO expected_before FROM ledger_entries
           WHERE account_type = 'WALLET' AND wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
          -- Version 1 is the opening; a wallet opened empty has no entry at version 1, so version 2 starts from zero.
          IF expected_before IS NULL AND NEW.wallet_version <= 2 THEN
            expected_before := 0;
          END IF;
          IF expected_before IS DISTINCT FROM NEW.balance_before_minor THEN
            RAISE EXCEPTION 'integrity: wallet % posting at version % does not continue the previous balance',
              NEW.wallet_id, NEW.wallet_version USING ERRCODE = 'P0001';
          END IF;
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_entries_consistent AFTER INSERT ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_ledger_consistent()`);
  }

  override down(): void {
    this.addSql('DROP TRIGGER IF EXISTS ledger_entries_consistent ON ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS assert_ledger_consistent()');
    this.addSql('DROP TRIGGER IF EXISTS wallets_match_ledger ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS assert_wallet_matches_ledger()');
    this.addSql('DROP TRIGGER IF EXISTS wallets_guard_update ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS guard_wallet_update()');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_guard_update ON wager_transactions');
    this.addSql('DROP FUNCTION IF EXISTS guard_wager_transaction_update()');
    this.addSql('DROP TRIGGER IF EXISTS wallets_no_truncate ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS wallets_no_delete ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_no_truncate ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_no_delete ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries');
    this.addSql('DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS forbid_mutation()');
  }
}
