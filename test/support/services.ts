import type { MikroORM } from '@mikro-orm/postgresql';
import { AuditRecorder } from '../../src/application/audit/audit-recorder';
import { parseWagerCommand, type WagerCommand } from '../../src/application/wagering/wager-command';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { UuidV7Generator } from '../../src/infrastructure/system';
import { RecordingLogger, RecordingMetrics } from './observability';
import { ManualClock, runnerFor } from './orm';

export const SUPPORTED = new Set(['BRL', 'USD']);

export function buildServices(orm: MikroORM) {
  const runner = runnerFor(orm);
  const logger = new RecordingLogger();
  const metrics = new RecordingMetrics();
  const clock = new ManualClock();
  const ids = new UuidV7Generator();
  const audit = new AuditRecorder(runner, logger, metrics);
  return {
    runner,
    logger,
    metrics,
    clock,
    openWallet: new OpenWallet(runner, audit, clock, ids, SUPPORTED),
    processWager: new ProcessWagerTransaction(runner, audit, clock, ids, logger, metrics),
  };
}

let counter = 0;

export function wagerCommand(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
): WagerCommand {
  counter += 1;
  const externalTransactionId = typeof overrides.externalTransactionId === 'string'
    ? overrides.externalTransactionId
    : `tx-${String(counter)}-${Bun.randomUUIDv7().slice(-6)}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
  return parseWagerCommand(body, idempotencyKey ?? `provider-a:${externalTransactionId}`, SUPPORTED);
}

export const httpCtx = (correlationId = `corr-${Bun.randomUUIDv7()}`) => ({
  source: 'HTTP' as const,
  actor: 'provider-a',
  correlationId,
});
