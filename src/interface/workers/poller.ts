import type { Logger } from '../../application/ports/observability';

/**
 * Runs `task` in a loop: immediately again while it finds work, after `idleMs` when it finds none.
 * `stop()` interrupts the idle wait and resolves once the current iteration has finished.
 */
export class Poller {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly task: () => Promise<number>,
    private readonly idleMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      let worked = 0;
      try {
        worked = await this.task();
      } catch (error) {
        this.logger.error({ err: error, worker: this.name }, 'background worker iteration failed');
      }
      if (worked === 0 && !this.isStopping()) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idleMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
