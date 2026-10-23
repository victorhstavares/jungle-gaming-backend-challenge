import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AuditRecorder } from '../../../src/application/audit/audit-recorder';
import { ContractError, WalletAlreadyExistsError } from '../../../src/application/errors';
import { OpenWallet } from '../../../src/application/wallets/open-wallet';
import { UuidV7Generator } from '../../../src/infrastructure/system';
import { createTestDatabase, rejectionOf, type TestDatabase } from '../../support/db';
import { RecordingLogger, RecordingMetrics } from '../../support/observability';
import { ManualClock, openOrm, runnerFor } from '../../support/orm';

let db: TestDatabase;
let orm: MikroORM;
let openWallet: OpenWallet;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await openOrm(db.url);
  const runner = runnerFor(orm);
  const logger = new RecordingLogger();
  openWallet = new OpenWallet(
    runner,
    new AuditRecorder(runner, logger, new RecordingMetrics()),
    new ManualClock(),
    new UuidV7Generator(),
    new Set(['BRL', 'USD']),
  );
});

afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const input = (playerId: string, amount: string, currency = 'BRL') => ({
  playerId,
  initialBalance: { amount, currency },
  actor: 'backoffice',
  correlationId: `corr-${playerId}`,
});

const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> => {
  const [row] = await db.sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return Number(row?.n);
};

describe('OpenWallet', () => {
  test('opens a funded wallet with an OPENING transaction, double entry, events and audit in one commit', async () => {
    const playerId = Bun.randomUUIDv7();
    const view = await openWallet.execute(input(playerId, '1000.00'));

    expect(view).toEqual({
      id: view.id,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(await count('wager_transactions', `wallet_id = $1 AND kind = 'OPENING' AND status = 'PROCESSED'`, [view.id])).toBe(1);
    expect(await count('ledger_entries', `transaction_id IN (SELECT id FROM wager_transactions WHERE wallet_id = $1)`, [view.id])).toBe(2);
    expect(await count('outbox_messages', `aggregate_id = $1`, [view.id])).toBe(2);
    expect(await count('audit_log', `wallet_id = $1 AND operation = 'OPEN_WALLET' AND outcome = 'PROCESSED'`, [view.id])).toBe(1);
  });

  test('opens an empty wallet without transaction or ledger entries', async () => {
    const view = await openWallet.execute(input(Bun.randomUUIDv7(), '0.00'));

    expect(view.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await count('wager_transactions', 'wallet_id = $1', [view.id])).toBe(0);
    expect(await count('outbox_messages', 'aggregate_id = $1', [view.id])).toBe(1);
  });

  test('refuses a second wallet for the same player and currency and audits the attempt', async () => {
    const playerId = Bun.randomUUIDv7();
    await openWallet.execute(input(playerId, '10.00'));

    expect(await rejectionOf(openWallet.execute(input(playerId, '20.00')))).toBeInstanceOf(WalletAlreadyExistsError);
    expect(await count('wallets', 'player_id = $1', [playerId])).toBe(1);
    expect(
      await count('audit_log', `correlation_id = $1 AND outcome = 'CONTRACT_ERROR' AND code = 'WALLET_ALREADY_EXISTS'`, [
        `corr-${playerId}`,
      ]),
    ).toBe(1);

    const other = await openWallet.execute(input(playerId, '5.00', 'USD'));
    expect(other.balance.currency).toBe('USD');
  });

  test('rejects malformed money as a contract error', async () => {
    expect(await rejectionOf(openWallet.execute(input(Bun.randomUUIDv7(), '10.5')))).toBeInstanceOf(ContractError);
    expect(await rejectionOf(openWallet.execute(input(Bun.randomUUIDv7(), '10.00', 'JPY')))).toMatchObject({
      code: 'UNSUPPORTED_CURRENCY',
    });
  });
});
