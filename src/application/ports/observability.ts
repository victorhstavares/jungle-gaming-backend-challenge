export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type CounterName =
  | 'wager_transactions_total'
  | 'idempotent_replays_total'
  | 'idempotency_conflicts_total'
  | 'inbox_duplicates_total'
  | 'sqs_retries_total'
  | 'sqs_dlq_total'
  | 'wallet_lock_timeouts_total'
  | 'outbox_published_total'
  | 'outbox_publish_failures_total'
  | 'pending_reference_retries_total'
  | 'reconciliation_mismatches_total'
  | 'audit_write_failures_total'
  | 'auth_failures_total'
  | 'processing_failures_total';

export type HistogramName = 'wager_processing_seconds' | 'wallet_lock_wait_seconds';

export type GaugeName = 'outbox_lag_seconds';

export type Labels = Record<string, string>;

export interface Metrics {
  increment(name: CounterName, labels?: Labels, value?: number): void;
  observe(name: HistogramName, seconds: number, labels?: Labels): void;
  setGauge(name: GaugeName, value: number, labels?: Labels): void;
}
