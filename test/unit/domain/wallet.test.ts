import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-entry';
import { CurrencyMismatchError, Money } from '../../../src/domain/money/money';
import { InsufficientFundsError, Wallet } from '../../../src/domain/wallet/wallet';

const supported = new Set(['BRL', 'USD']);
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' }, supported);
const t0 = new Date('2026-10-23T12:00:00.000Z');
const t1 = new Date('2026-10-23T12:00:01.000Z');

function openWith(amount: string): ReturnType<typeof Wallet.open> {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    now: t0,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
  });
}

describe('Wallet.open', () => {
  test('credits a positive initial balance through an opening entry', () => {
    const { wallet, openingEntry } = openWith('1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe('tx-opening');
  });

  test('opens an empty wallet without a ledger entry', () => {
    const { wallet, openingEntry } = openWith('0.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });
});

describe('Wallet movements', () => {
  test('debit lowers the balance, bumps the version and returns the entry', () => {
    const { wallet } = openWith('100.00');

    const entry = wallet.debit(brl('80.00'), 'tx-bet', 'entry-bet', t1);

    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
    expect(entry.walletVersion).toBe(2);
  });

  test('debit beyond the balance fails and leaves the wallet untouched', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(brl('120.00'), 'tx-bet', 'entry-bet', t1)).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('credit raises the balance', () => {
    const { wallet } = openWith('10.00');

    const entry = wallet.credit(brl('5.50'), 'tx-win', 'entry-win', t1);

    expect(wallet.balance.equals(brl('15.50'))).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.version).toBe(2);
  });

  test('rejects movements in another currency', () => {
    const { wallet } = openWith('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' }, supported);

    expect(() => wallet.credit(usd, 'tx', 'entry', t1)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate rebuilds persisted state without revalidating transitions', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: t0,
      updatedAt: t1,
    });

    expect(wallet.version).toBe(17);
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
  });
});
