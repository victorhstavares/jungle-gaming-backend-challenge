import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type {
  CounterName,
  GaugeName,
  HistogramName,
  Labels,
  Metrics,
} from '../../application/ports/observability';

const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const COUNTERS: Record<CounterName, { help: string; labels: string[] }> = {
  wager_transactions_total: { help: 'Wager transactions settled, by kind and final status', labels: ['kind', 'status'] },
  idempotent_replays_total: { help: 'Requests answered from a stored result', labels: [] },
  idempotency_conflicts_total: { help: 'Idempotency keys reused with a different payload', labels: [] },
  inbox_duplicates_total: { help: 'Queue messages already received by the inbox', labels: [] },
  sqs_retries_total: { help: 'Queue messages returned for a later retry', labels: ['reason'] },
  sqs_dlq_total: { help: 'Queue messages moved to the dead-letter queue', labels: ['reason'] },
  wallet_lock_timeouts_total: { help: 'Wallet row lock waits that exceeded lock_timeout', labels: [] },
  outbox_published_total: { help: 'Outbox messages published', labels: [] },
  outbox_publish_failures_total: { help: 'Outbox publish attempts that failed', labels: [] },
  pending_reference_retries_total: { help: 'Pending-reference transactions rescheduled', labels: [] },
  reconciliation_mismatches_total: { help: 'Reconciliations where balance and ledger disagree', labels: [] },
  audit_write_failures_total: { help: 'Audit rows that could not be written', labels: [] },
  auth_failures_total: { help: 'Rejected authentication or authorization', labels: ['reason'] },
  processing_failures_total: { help: 'Wagers recorded as FAILED after a permanent error', labels: [] },
};

const HISTOGRAMS: Record<HistogramName, { help: string; labels: string[] }> = {
  wager_processing_seconds: { help: 'Time to settle a wager, by entry point', labels: ['source'] },
  wallet_lock_wait_seconds: { help: 'Time spent waiting for the wallet row lock', labels: [] },
};

const GAUGES: Record<GaugeName, { help: string; labels: string[] }> = {
  outbox_lag_seconds: { help: 'Age of the oldest unpublished outbox message', labels: [] },
};

export class PrometheusMetrics implements Metrics {
  private readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();

  constructor(options: { defaultMetrics?: boolean } = {}) {
    for (const [name, spec] of Object.entries(COUNTERS)) {
      this.counters.set(name, new Counter<string>({ name, help: spec.help, labelNames: spec.labels, registers: [this.registry] }));
    }
    for (const [name, spec] of Object.entries(HISTOGRAMS)) {
      this.histograms.set(
        name,
        new Histogram<string>({ name, help: spec.help, labelNames: spec.labels, buckets: LATENCY_BUCKETS, registers: [this.registry] }),
      );
    }
    for (const [name, spec] of Object.entries(GAUGES)) {
      this.gauges.set(name, new Gauge<string>({ name, help: spec.help, labelNames: spec.labels, registers: [this.registry] }));
    }
    if (options.defaultMetrics === true) collectDefaultMetrics({ register: this.registry });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  increment(name: CounterName, labels: Labels = {}, value = 1): void {
    this.counters.get(name)?.inc(labels, value);
  }

  observe(name: HistogramName, seconds: number, labels: Labels = {}): void {
    this.histograms.get(name)?.observe(labels, seconds);
  }

  setGauge(name: GaugeName, value: number, labels: Labels = {}): void {
    this.gauges.get(name)?.set(labels, value);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
