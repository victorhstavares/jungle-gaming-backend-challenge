import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-entry';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/domain/events/wagering-events';
import { WalletBalanceChanged, WalletOpened } from '../../../src/domain/events/wallet-events';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-kind';
import { brl, t0, t1, wager, walletWith } from './wager-fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: t1 };

describe('WalletBalanceChanged', () => {
  const wallet = walletWith('100.00');
  const entry = wallet.debit(brl('25.00'), 'tx-1', 'entry-1', t1);
  const evt = WalletBalanceChanged.from(wallet, entry, ctx);

  test('serializes a stable, versioned envelope with money as decimal strings', () => {
    expect(evt.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-23T12:00:05.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('round-trips through JSON unchanged', () => {
    expect(JSON.parse(JSON.stringify(evt))).toEqual(evt.toJSON());
  });
});

describe('wagering events', () => {
  test('processed carries the observed balance', () => {
    const tx = wager(Kind.Bet, '25.00');
    tx.markProcessed(undefined, brl('75.00'), t1);
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();

    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe(tx.id);
    expect(json.data.resultBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.kind).toBe(Kind.Bet);
  });

  test('rejected carries the failure code', () => {
    const tx = wager(Kind.Bet, '120.00');
    tx.reject(FailureCode.InsufficientFunds, brl('100.00'), t1);
    expect(WagerTransactionRejected.from(tx, ctx).toJSON().data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('pending reference names the missing reference', () => {
    const tx = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(t1);
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe('ext-bet');
    expect(json.data.attempts).toBe(1);
  });

  test('omits causation when absent', () => {
    const json = WalletOpened.from(walletWith('0.00'), { eventId: 'e', correlationId: 'c', occurredAt: t0 }).toJSON();
    expect('causationId' in json).toBe(false);
  });
});
