import type { CounterpartEntry, WalletLedgerEntry } from '../../domain/ledger/ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { AuditEntry } from './audit';

export interface WalletRepository {
  /** SELECT ... FOR UPDATE on the wallet row: the unit of concurrency. */
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Makes PENDING_REFERENCE transactions waiting on this external id due now instead of after their backoff. */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  /** Leases due PENDING_REFERENCE transactions by pushing next_attempt_at forward; skips rows other workers hold. */
  claimPendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]>;
}

export interface LedgerPageItem {
  seq: bigint;
  entry: WalletLedgerEntry;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry, counterpart: CounterpartEntry): Promise<void>;
  page(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<LedgerPageItem[]>;
  sumForWallet(walletId: string): Promise<{ balanceMinor: bigint; entries: number }>;
}

export interface InboxRepository {
  /** Inserts the message; false means it was already received by this consumer. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
  payloadHashOf(consumerName: string, messageId: string): Promise<string | undefined>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  claim(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(messages: readonly OutboxMessage[]): Promise<void>;
  recordFailure(message: OutboxMessage, error: string): Promise<void>;
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}

export interface ReconciliationRun {
  id: string;
  walletId: string;
  actor: string;
  correlationId: string;
  stored: Money;
  calculated: Money;
  checkedEntries: number;
  checkedAt: Date;
}

export interface ReconciliationRepository {
  record(run: ReconciliationRun): Promise<void>;
}

export interface TxRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  audit: AuditRepository;
  reconciliations: ReconciliationRepository;
}

export interface TransactionContext {
  correlationId: string;
}

export interface TransactionRunner {
  /** Runs `work` in one SQL transaction; everything it writes commits or rolls back together. */
  run<T>(ctx: TransactionContext, work: (repos: TxRepositories) => Promise<T>): Promise<T>;
}
