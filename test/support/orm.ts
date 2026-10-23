import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { PERSISTENCE_RECORDS } from '../../src/infrastructure/persistence/records';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/transaction-runner';
import type { Clock } from '../../src/application/ports/clock';

export class ManualClock implements Clock {
  constructor(private current = new Date('2026-10-23T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export async function openOrm(databaseUrl: string, poolMax = 10): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig({ databaseUrl, poolMax, entities: PERSISTENCE_RECORDS }));
}

export function runnerFor(orm: MikroORM, lockTimeoutMs = 5_000): MikroOrmTransactionRunner {
  return new MikroOrmTransactionRunner(orm, { lockTimeoutMs, statementTimeoutMs: 10_000 });
}
