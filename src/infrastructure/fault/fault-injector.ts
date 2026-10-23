import type { FaultInjector, FaultPoint } from '../../application/ports/messaging';

export class ProcessExitFaultInjector implements FaultInjector {
  constructor(private readonly armed: FaultPoint | undefined) {}

  at(point: FaultPoint): void {
    if (this.armed === point) {
      // Exit code 137 is what a SIGKILL looks like; the process skips cleanup, the ack and shutdown hooks.
      process.exit(137);
    }
  }
}
