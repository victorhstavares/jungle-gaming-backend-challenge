import type { TransactionContext, TransactionRunner, TxRepositories } from '../../src/application/ports/repositories';

/** Wraps a real runner and fails its next `times` calls with the given error before touching the database. */
export class FlakyRunner implements TransactionRunner {
  private remaining = 0;
  private error: Error = new Error('unset');

  constructor(private readonly inner: TransactionRunner) {}

  failNext(times: number, error: Error): void {
    this.remaining = times;
    this.error = error;
  }

  run<T>(ctx: TransactionContext, work: (repos: TxRepositories) => Promise<T>): Promise<T> {
    if (this.remaining > 0) {
      this.remaining -= 1;
      return Promise.reject(this.error);
    }
    return this.inner.run(ctx, work);
  }
}
