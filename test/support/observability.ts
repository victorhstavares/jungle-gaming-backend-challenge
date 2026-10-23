import type {
  CounterName,
  GaugeName,
  HistogramName,
  Labels,
  Logger,
  Metrics,
} from '../../src/application/ports/observability';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

export class RecordingLogger implements Logger {
  readonly lines: LogLine[] = [];

  info(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'info', fields, message });
  }

  warn(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'warn', fields, message });
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'error', fields, message });
  }
}

const key = (name: string, labels: Labels = {}): string =>
  `${name}${JSON.stringify(Object.fromEntries(Object.entries(labels).sort()))}`;

export class RecordingMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  readonly observations: { name: HistogramName; seconds: number }[] = [];
  readonly gauges = new Map<string, number>();

  increment(name: CounterName, labels?: Labels, value = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  observe(name: HistogramName, seconds: number): void {
    this.observations.push({ name, seconds });
  }

  setGauge(name: GaugeName, value: number, labels?: Labels): void {
    this.gauges.set(key(name, labels), value);
  }

  count(name: CounterName, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }
}
