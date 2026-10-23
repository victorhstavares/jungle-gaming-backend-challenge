/**
 * Chaos demo against the compose stack: HTTP and SQS load while instances are SIGKILLed at random, then a
 * reconciliation of every wallet. Exits 1 if any wallet's balance differs from its ledger.
 *
 *   docker compose up -d --build --wait
 *   bun run demo:chaos -- --duration 60 --wallets 20
 */
import { $ } from 'bun';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    duration: { type: 'string', default: '60' },
    wallets: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '20' },
    api: { type: 'string', default: 'http://localhost:3000' },
    'token-url': { type: 'string', default: 'http://localhost:8080/realms/jungle/protocol/openid-connect/token' },
    queue: { type: 'string', default: 'http://localhost:4566/000000000000/wager-transactions.fifo' },
  },
});

const API = args.api;
const INSTANCES = ['wagering-app-1-1', 'wagering-app-2-1', 'wagering-app-3-1'];
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function token(clientId: string, secret: string): Promise<string> {
  const res = await fetch(args['token-url'], {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function post(path: string, auth: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sql(query: string): Promise<string> {
  return (await $`docker compose exec -T postgres psql -U wagering -d wagering -tAc ${query}`.quiet().text()).trim();
}

const log = (message: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
};

const operator = await token('backoffice', 'backoffice-dev-secret');
const provider = await token('provider-a', 'provider-a-dev-secret');

const wallets: { walletId: string; playerId: string }[] = [];
for (let i = 0; i < Number(args.wallets); i += 1) {
  const playerId = crypto.randomUUID();
  const res = await post('/wallets', operator, { playerId, initialBalance: { amount: '500.00', currency: 'BRL' } });
  wallets.push({ walletId: String(res.json.id), playerId });
}
log(`${String(wallets.length)} wallets opened with 500.00 BRL each`);

const counters = { http: 0, httpFailed: 0, queued: 0, kills: 0 };
const deadline = Date.now() + Number(args.duration) * 1000;
let sequence = 0;

async function traffic(): Promise<void> {
  while (Date.now() < deadline) {
    const wallet = wallets[Math.floor(Math.random() * wallets.length)];
    if (wallet === undefined) continue;
    sequence += 1;
    const externalTransactionId = `chaos-${String(sequence)}-${crypto.randomUUID().slice(0, 8)}`;
    const kind = Math.random() < 0.7 ? 'BET' : 'WIN';
    const body = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: `round-${String(sequence)}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount: '7.00', currency: 'BRL' },
    };
    const key = `provider-a:${externalTransactionId}`;
    if (Math.random() < 0.3) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: args.queue,
          MessageBody: JSON.stringify({ messageId: `chaos-msg-${externalTransactionId}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...body, idempotencyKey: key } }),
          MessageGroupId: wallet.walletId,
          MessageDeduplicationId: externalTransactionId,
        }),
      );
      counters.queued += 1;
      continue;
    }
    // A provider retries with the same key until it gets an answer, as a real one would after a dropped connection.
    let answered = false;
    for (let attempt = 0; attempt < 5 && !answered; attempt += 1) {
      const res = await post('/wagering/transactions', provider, body, { 'idempotency-key': key }).catch(() => undefined);
      answered = res !== undefined && res.status < 500;
      if (!answered) await Bun.sleep(200);
    }
    if (answered) counters.http += 1;
    else counters.httpFailed += 1;
  }
}

async function chaosMonkey(): Promise<void> {
  while (Date.now() < deadline - 5_000) {
    await Bun.sleep(10_000);
    const victim = INSTANCES[Math.floor(Math.random() * INSTANCES.length)] ?? 'wagering-app-1-1';
    log(`SIGKILL ${victim}`);
    await $`docker kill --signal KILL ${victim}`.quiet().nothrow();
    counters.kills += 1;
    await Bun.sleep(5_000);
    await $`docker start ${victim}`.quiet().nothrow();
    log(`restarted ${victim}`);
  }
}

log(`load for ${args.duration}s with ${args.concurrency} clients, killing an instance every 10s`);
await Promise.all([...Array.from({ length: Number(args.concurrency) }, traffic), chaosMonkey()]);
log(`load done: ${String(counters.http)} HTTP requests, ${String(counters.queued)} queued messages, ${String(counters.kills)} kills`);

log('waiting for queue, outbox and pending references to drain...');
const drainDeadline = Date.now() + 180_000;
for (;;) {
  const pending = await sql(
    `SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL) || ' ' ||
            (SELECT count(*) FROM wager_transactions WHERE status IN ('PENDING','PENDING_REFERENCE')) || ' ' ||
            (SELECT count(*) FROM wager_transactions WHERE external_transaction_id LIKE 'chaos-%' AND created_at > now() - interval '15 minutes')`,
  );
  const [outbox, waiting, persisted] = pending.split(' ').map(Number);
  if (outbox === 0 && waiting === 0 && persisted === counters.http + counters.queued) break;
  if (Date.now() > drainDeadline) {
    log(`drain timed out: outbox=${String(outbox)} pending=${String(waiting)} persisted=${String(persisted)}/${String(counters.http + counters.queued)}`);
    break;
  }
  await Bun.sleep(2_000);
}

console.log('\n| Wallet | Stored | From ledger | Consistent |\n|---|---|---|---|');
let inconsistent = 0;
for (const { walletId } of wallets) {
  const res = await post(`/wallets/${walletId}/reconciliation`, operator, {});
  const stored = res.json.storedBalance as { amount: string } | undefined;
  const calculated = res.json.calculatedBalance as { amount: string } | undefined;
  if (res.json.consistent !== true) inconsistent += 1;
  console.log(`| …${walletId.slice(-12)} | ${stored?.amount ?? '?'} | ${calculated?.amount ?? '?'} | ${res.json.consistent === true ? 'yes' : 'NO'} |`);
}

const audit = await sql(
  `SELECT string_agg(outcome || '=' || n, ', ' ORDER BY outcome) FROM
     (SELECT outcome, count(*) AS n FROM audit_log
       WHERE wallet_id IN (${wallets.map((w) => `'${w.walletId}'`).join(',')}) GROUP BY outcome) t`,
);
console.log(`\nAudit outcomes in this run: ${audit}`);
console.log(`HTTP requests that never got an answer after 5 tries: ${String(counters.httpFailed)}`);
console.log(inconsistent === 0 ? '\nAll wallets consistent.' : `\n${String(inconsistent)} wallet(s) INCONSISTENT.`);
process.exit(inconsistent === 0 ? 0 : 1);
