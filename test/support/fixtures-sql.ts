import type { TestDatabase } from './db';

export const ids = {
  wallet: '0192f291-27dd-7d3f-8071-5f8685deef37',
  player: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
};

let counter = 0;
export const uuid = (): string => Bun.randomUUIDv7();
const nextExternal = (): string => `ext-${(counter += 1)}`;

export async function insertWallet(
  db: TestDatabase,
  overrides: { id?: string; playerId?: string; currency?: string; balance?: bigint; version?: number } = {},
): Promise<string> {
  const id = overrides.id ?? uuid();
  await db.sql(
    `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [id, overrides.playerId ?? uuid(), overrides.currency ?? 'BRL', overrides.balance ?? 0n, overrides.version ?? 1],
  );
  return id;
}

export interface TxRow {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  walletId: string;
  playerId?: string;
  kind?: string;
  amount?: bigint;
  status?: string;
  failureCode?: string | null;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  processedAt?: Date | null;
  nextAttemptAt?: Date | null;
}

export function txInsert(row: TxRow): [string, unknown[]] {
  const external = row.externalId ?? nextExternal();
  const status = row.status ?? 'PENDING';
  return [
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount_minor, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, result_balance_minor, attempts, next_attempt_at,
       created_at, updated_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'round-1','game-1',$8,$9,'BRL',$10,$11,$12,$13,NULL,0,$14,now(),now(),$15)`,
    [
      row.id ?? uuid(),
      row.providerId ?? 'provider-a',
      external,
      row.idempotencyKey ?? `provider-a:${external}`,
      'a'.repeat(64),
      row.walletId,
      row.playerId ?? uuid(),
      row.kind ?? 'BET',
      row.amount ?? 100n,
      row.referenceExternalId ?? null,
      row.referenceTransactionId ?? null,
      status,
      row.failureCode ?? null,
      row.nextAttemptAt ?? null,
      row.processedAt ?? (status === 'PROCESSED' ? new Date() : null),
    ],
  ];
}

export async function insertTx(db: TestDatabase, row: TxRow): Promise<string> {
  const [text, params] = txInsert(row);
  await db.sql(text, params);
  return String(params[0]);
}
