/**
 * Load test against the compose stack (nginx + three instances + Keycloak).
 *
 *   docker compose up -d --build --wait
 *   bun run test:load -- --duration 60 --concurrency 50 --wallets 100
 *
 * Prints a Markdown report and writes it to docs/load-test.md.
 */
import { $ } from 'bun';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    duration: { type: 'string', default: '60' },
    concurrency: { type: 'string', default: '50' },
    wallets: { type: 'string', default: '100' },
    api: { type: 'string', default: 'http://localhost:3000' },
    'token-url': { type: 'string', default: 'http://localhost:8080/realms/jungle/protocol/openid-connect/token' },
    out: { type: 'string', default: 'docs/load-test.md' },
  },
});

const DURATION_MS = Number(args.duration) * 1000;
const CONCURRENCY = Number(args.concurrency);
const WALLETS = Number(args.wallets);
const API = args.api;

async function token(clientId: string, secret: string): Promise<string> {
  const res = await fetch(args['token-url'], {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`token for ${clientId}: HTTP ${String(res.status)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

interface Sample {
  op: string;
  status: number;
  ms: number;
  code?: string;
  replay: boolean;
}

interface WalletState {
  walletId: string;
  playerId: string;
  refundable: string[];
  sent: { body: Record<string, unknown>; key: string }[];
}

const operator = await token('backoffice', 'backoffice-dev-secret');
const provider = await token('provider-a', 'provider-a-dev-secret');

async function post(path: string, auth: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

console.error(`creating ${String(WALLETS)} wallets...`);
const wallets: WalletState[] = [];
for (let i = 0; i < WALLETS; i += 1) {
  const playerId = crypto.randomUUID();
  const res = await post('/wallets', operator, { playerId, initialBalance: { amount: '10000.00', currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${String(res.status)}`);
  wallets.push({ walletId: String(res.json.id), playerId, refundable: [], sent: [] });
}

const samples: Sample[] = [];
let sequence = 0;

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

async function oneRequest(): Promise<void> {
  const wallet = pick(wallets);
  const roll = Math.random();
  let op: string;
  let body: Record<string, unknown>;
  let key: string;
  let replay = false;

  if (roll < 0.1 && wallet.sent.length > 0) {
    ({ body, key } = pick(wallet.sent));
    op = 'REPLAY';
    replay = true;
  } else {
    sequence += 1;
    const externalTransactionId = `load-${String(sequence)}-${crypto.randomUUID().slice(0, 8)}`;
    const base = { providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId, walletId: wallet.walletId, roundId: `round-${String(sequence)}`, gameId: 'fortune-chimp' };
    const kindRoll = Math.random();
    const refundTarget = wallet.refundable.at(-1);
    if (kindRoll < 0.05 && refundTarget !== undefined) {
      wallet.refundable.pop();
      op = 'REFUND';
      body = { ...base, roundId: refundTarget.split('|')[1], kind: 'REFUND', money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: refundTarget.split('|')[0] };
    } else if (kindRoll < 0.65) {
      op = 'BET';
      body = { ...base, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } };
    } else if (kindRoll < 0.9) {
      op = 'WIN';
      body = { ...base, kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } };
    } else {
      op = 'LOSS';
      body = { ...base, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
    }
    key = `provider-a:${externalTransactionId}`;
  }

  const started = performance.now();
  let status: number;
  let code: string | undefined;
  try {
    const res = await post('/wagering/transactions', provider, body, { 'idempotency-key': key });
    status = res.status;
    code = typeof res.json.failureCode === 'string' ? res.json.failureCode : typeof res.json.code === 'string' ? res.json.code : undefined;
  } catch {
    status = 0;
  }
  samples.push({ op, status, ms: performance.now() - started, ...(code === undefined ? {} : { code }), replay });

  if (!replay) {
    wallet.sent.push({ body, key });
    if (wallet.sent.length > 50) wallet.sent.shift();
    if (op === 'BET' && status === 201) wallet.refundable.push(`${String(body.externalTransactionId)}|${String(body.roundId)}`);
  }
}

console.error(`running ${String(CONCURRENCY)} workers for ${args.duration}s...`);
const startedAt = performance.now();
const deadline = startedAt + DURATION_MS;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) await oneRequest();
  }),
);
const elapsedS = (performance.now() - startedAt) / 1000;

const metrics = await (await fetch(`${API}/metrics`)).text();
const metric = (pattern: RegExp): string => pattern.exec(metrics)?.[1] ?? 'n/a';

console.error('reconciling every wallet...');
let consistent = 0;
for (const wallet of wallets) {
  const res = await post(`/wallets/${wallet.walletId}/reconciliation`, operator, {});
  if (res.json.consistent === true) consistent += 1;
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const latencies = samples.map((s) => s.ms);
const byStatus = new Map<number, number>();
for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
const byCode = new Map<string, number>();
for (const s of samples) if (s.code !== undefined) byCode.set(s.code, (byCode.get(s.code) ?? 0) + 1);
const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
const replays = samples.filter((s) => s.replay);
const replayOk = replays.filter((s) => s.status < 500).length;

const cpu = cpus()[0]?.model ?? 'unknown';
const bunVersion = Bun.version;
const dockerVersion = (await $`docker version --format '{{.Server.Version}}'`.quiet().nothrow().text()).trim();
const fmt = (n: number): string => n.toFixed(1);

const report = `# Teste de carga

Gerado por \`bun run test:load -- --duration ${args.duration} --concurrency ${String(CONCURRENCY)} --wallets ${String(WALLETS)}\` em ${new Date().toISOString()}.

## Ambiente

| Item | Valor |
|---|---|
| CPU | ${cpu} (${String(cpus().length)} threads) |
| Memória | ${fmt(totalmem() / 1024 ** 3)} GiB |
| Sistema | Windows + WSL2, Docker Desktop ${dockerVersion} |
| Bun | ${bunVersion} |
| Topologia | nginx → 3 instâncias (todos os papéis) → Postgres 17 e LocalStack 4.9, tudo no mesmo host |

## Metodologia

- ${String(WALLETS)} wallets com saldo inicial de 10000.00 BRL, criadas antes da medição.
- ${String(CONCURRENCY)} clientes concorrentes em laço fechado por ${args.duration}s, cada um escolhendo uma wallet ao acaso.
- Mistura: 10% replays de uma requisição anterior (mesma key e corpo); do restante, 60% BET, 25% WIN, 10% LOSS e 5% REFUND de uma BET já processada.
- Token client credentials real do Keycloak; toda requisição passa pelo nginx.
- Ao final, reconciliação de todas as wallets pela API.

## Resultados

| Métrica | Valor |
|---|---|
| Requisições | ${String(samples.length)} |
| Throughput | ${fmt(samples.length / elapsedS)} req/s |
| p50 | ${fmt(percentile(latencies, 50))} ms |
| p95 | ${fmt(percentile(latencies, 95))} ms |
| p99 | ${fmt(percentile(latencies, 99))} ms |
| Taxa de erro (5xx ou falha de rede) | ${fmt((errors / Math.max(1, samples.length)) * 100)}% (${String(errors)}) |
| Replays respondidos sem erro | ${String(replayOk)} de ${String(replays.length)} |
| Wallets consistentes na reconciliação | ${String(consistent)} de ${String(WALLETS)} |
| Timeouts de lock da wallet (uma instância) | ${metric(/^wallet_lock_timeouts_total (\S+)$/m)} |
| Espera de lock acumulada (uma instância) | ${fmt(Number(metric(/^wallet_lock_wait_seconds_sum (\S+)$/m)))} s em ${metric(/^wallet_lock_wait_seconds_count (\S+)$/m)} locks |
| Outbox lag no fim (uma instância) | ${metric(/^outbox_lag_seconds (\S+)$/m)} s |

### Respostas por status

| Status | Quantidade |
|---|---|
${[...byStatus.entries()].sort(([a], [b]) => a - b).map(([status, n]) => `| ${String(status)} | ${String(n)} |`).join('\n')}

### Códigos de rejeição ou erro

| Código | Quantidade |
|---|---|
${[...byCode.entries()].sort(([, a], [, b]) => b - a).map(([code, n]) => `| ${code} | ${String(n)} |`).join('\n') || '| (nenhum) | 0 |'}
`;

await Bun.write(args.out, report);
console.log(report);
