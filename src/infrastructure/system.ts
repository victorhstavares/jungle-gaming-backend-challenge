import type { Clock, IdGenerator } from '../application/ports/clock';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Time-ordered UUIDs keep primary-key inserts appending to the end of the btree. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
