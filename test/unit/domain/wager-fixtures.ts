import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-kind';

export const supported = new Set(['BRL', 'USD']);
export const t0 = new Date('2026-10-23T12:00:00.000Z');
export const t1 = new Date('2026-10-23T12:00:05.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' }, supported);

export function walletWith(amount: string, currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency,
    balance: Money.from({ amount, currency }, supported),
    version: 1,
    createdAt: t0,
    updatedAt: t0,
  });
}

let sequence = 0;

export function wager(
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: t0,
    ...overrides,
  });
}

export function processed(tx: WagerTransaction): WagerTransaction {
  tx.markProcessed(undefined, brl('0.00'), t0);
  return tx;
}
