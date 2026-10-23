import { defineConfig, PostgreSqlDriver, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261023000001Core } from './migrations/Migration20261023000001_core';
import { Migration20261023000002Integrity } from './migrations/Migration20261023000002_integrity';
import { Migration20261023000003Audit } from './migrations/Migration20261023000003_audit';
import { Migration20261023000004OutboxOrder } from './migrations/Migration20261023000004_outbox_order';
import { Migration20261023000005OutboxSequence } from './migrations/Migration20261023000005_outbox_sequence';

export const MIGRATIONS = [
  { name: 'Migration20261023000001_core', class: Migration20261023000001Core },
  { name: 'Migration20261023000002_integrity', class: Migration20261023000002Integrity },
  { name: 'Migration20261023000003_audit', class: Migration20261023000003Audit },
  { name: 'Migration20261023000004_outbox_order', class: Migration20261023000004OutboxOrder },
  { name: 'Migration20261023000005_outbox_sequence', class: Migration20261023000005OutboxSequence },
];

export interface OrmConfigInput {
  databaseUrl: string;
  poolMax: number;
  entities?: Options['entities'];
}

export function createOrmConfig(input: OrmConfigInput): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: input.databaseUrl,
    entities: input.entities ?? [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: input.poolMax },
    // Client-side limits: a frozen or unreachable server cannot enforce statement_timeout, so without these a
    // request would hang instead of failing fast with a retryable 503.
    driverOptions: {
      connectionTimeoutMillis: 3_000,
      query_timeout: 12_000,
      keepAlive: true,
    },
    migrations: {
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    debug: false,
  });
}
