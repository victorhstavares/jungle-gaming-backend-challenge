import { expect } from 'bun:test';
import { startApp, type AppProcess } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { testEnv } from '../support/http';
import { createTestQueues, type TestQueues } from '../support/sqs';
import { startTestIssuer, type TestIssuer } from '../support/tokens';

export interface Cluster {
  db: TestDatabase;
  queues: TestQueues;
  issuer: TestIssuer;
  apps: AppProcess[];
  operator: string;
  provider: string;
  env: Record<string, string>;
  restart: (index: number) => Promise<void>;
  stop: () => Promise<void>;
}

/** N real processes with every role enabled, sharing one database and one set of queues, as in the compose deployment. */
export async function startCluster(instances = 3): Promise<Cluster> {
  const db = await createTestDatabase();
  const queues = await createTestQueues({ visibilityTimeout: 5 });
  const issuer = await startTestIssuer();
  const env = testEnv(db.url, issuer, {
    APP_ROLES: 'api,consumer,outbox,pending-reference',
    WAGER_QUEUE_URL: queues.wagerUrl,
    WAGER_DLQ_URL: queues.dlqUrl,
    EVENTS_QUEUE_URL: queues.eventsUrl,
    DATABASE_POOL_MAX: '15',
  });
  const apps = await Promise.all(Array.from({ length: instances }, () => startApp(env)));
  const cluster: Cluster = {
    db,
    queues,
    issuer,
    apps,
    env,
    operator: await issuer.operator(),
    provider: await issuer.provider('provider-a'),
    restart: async (index) => {
      apps[index] = await startApp(env);
    },
    stop: async () => {
      await Promise.all(apps.map((app) => (app.proc.exitCode === null ? app.kill('SIGTERM') : Promise.resolve(app.proc.exitCode))));
      await issuer.stop();
      await queues.destroy();
      await db.drop();
    },
  };
  return cluster;
}

export interface Response {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export async function request(
  url: string,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

export async function openWallet(cluster: Cluster, amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const res = await request(cluster.apps[0]?.url ?? '', 'POST', '/wallets', cluster.operator, {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(res.status).toBe(201);
  return { walletId: String(res.body.id), playerId };
}

let seq = 0;
export function wager(walletId: string, playerId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `cc-${String(seq)}-${Bun.randomUUIDv7().slice(-10)}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  };
}

export function submit(cluster: Cluster, instance: number, body: Record<string, unknown>, key?: string): Promise<Response> {
  const app = cluster.apps[instance % cluster.apps.length];
  return request(app?.url ?? '', 'POST', '/wagering/transactions', cluster.provider, body, {
    'idempotency-key': key ?? `provider-a:${String(body.externalTransactionId)}`,
  });
}

export async function until(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(100);
  }
}

export async function count(db: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.sql(sql, params))[0]?.n);
}
