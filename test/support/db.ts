import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';
const TEMPLATE_DB = 'wallet_template';
const TEMPLATE_LOCK_KEY = 4_242_001;

export type Row = Record<string, unknown>;

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  sql: (text: string, params?: unknown[]) => Promise<Row[]>;
  /** Runs statements on one dedicated connection inside BEGIN/COMMIT, so deferred constraints fire at the end. */
  transaction: (statements: (run: (text: string, params?: unknown[]) => Promise<Row[]>) => Promise<void>) => Promise<void>;
  drop: () => Promise<void>;
}

const urlFor = (database: string): string => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

let templateReady: Promise<void> | undefined;

async function buildTemplate(): Promise<void> {
  const admin = new SQL(ADMIN_URL);
  try {
    await admin.unsafe(`SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY})`);
    const leftovers = await admin.unsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'test\\_%'`,
    );
    for (const { datname } of leftovers) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
    const orm = await MikroORM.init(createOrmConfig({ databaseUrl: urlFor(TEMPLATE_DB), poolMax: 2 }));
    try {
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
  } finally {
    await admin.unsafe(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`);
    await admin.close();
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  templateReady ??= buildTemplate();
  await templateReady;

  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.close();

  const url = urlFor(name);
  const client = new SQL(url);

  return {
    name,
    url,
    sql: (text, params = []) => client.unsafe<Row[]>(text, params),
    transaction: async (statements) => {
      await client.begin(async (tx) => {
        await statements((text, params = []) => tx.unsafe<Row[]>(text, params));
      });
    },
    drop: async () => {
      await client.close();
      const cleanup = new SQL(ADMIN_URL);
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.close();
    },
  };
}

/** Resolves to the SQLSTATE of the failure, or undefined when the statement succeeds. */
export async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const err = error as { errno?: string; code?: string };
    return err.errno ?? err.code;
  }
}

export async function constraintOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
}

/** Resolves to whatever the promise rejected with; fails the test if it resolved. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}
