import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();
const CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Uses the caller's id when it is safe to log and index, otherwise starts a new one. */
export function correlationIdFrom(header: string | undefined): string {
  return header !== undefined && CORRELATION_ID.test(header) ? header : Bun.randomUUIDv7();
}

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
