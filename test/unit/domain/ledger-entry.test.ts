import { describe, expect, test } from 'bun:test';
import {
  CounterpartEntry,
  LedgerAccountType,
  LedgerDirection,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/ledger/ledger-entry';
import { Money } from '../../../src/domain/money/money';

const brl = (minor: bigint): Money => Money.ofMinor(minor, 'BRL');
const now = new Date('2026-10-23T12:00:00.000Z');

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  walletVersion: 2,
  createdAt: now,
};

describe('WalletLedgerEntry.create', () => {
  test('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl(8000n),
      balanceBefore: brl(10000n),
      balanceAfter: brl(2000n),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects arithmetic that does not add up', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl(100n),
        balanceBefore: brl(0n),
        balanceAfter: brl(200n),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects non-positive amounts and negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl(0n),
        balanceBefore: brl(0n),
        balanceAfter: brl(0n),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl(100n),
        balanceBefore: brl(50n),
        balanceAfter: brl(-50n),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});

describe('CounterpartEntry.for', () => {
  test('mirrors the wallet entry with the opposite direction', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl(2500n),
      balanceBefore: brl(10000n),
      balanceAfter: brl(7500n),
    });
    const counterpart = CounterpartEntry.for(entry, LedgerAccountType.ProviderClearing, 'provider-a:BRL', 'entry-2');

    expect(counterpart.direction).toBe(LedgerDirection.Credit);
    expect(counterpart.money.equals(entry.money)).toBe(true);
    expect(counterpart.transactionId).toBe('tx-1');
    expect(counterpart.accountId).toBe('provider-a:BRL');
  });
});
