import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-entry';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-kind';
import { decide } from '../../../src/domain/wagering/wager-rules';
import type { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { brl, processed, t0, wager, walletWith } from './wager-fixtures';

const run = (
  tx: WagerTransaction,
  balance: string,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): ReturnType<typeof decide> =>
  decide({
    tx,
    wallet: walletWith(balance),
    ...(reference === undefined ? {} : { reference }),
    referenceAlreadyReversed,
  });

const refTo = (ref: WagerTransaction): { referenceExternalTransactionId: string } => ({
  referenceExternalTransactionId: ref.externalTransactionId,
});

describe('BET', () => {
  test('debits when the balance covers it', () => {
    expect(run(wager(Kind.Bet, '80.00'), '100.00')).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('debits the whole balance', () => {
    expect(run(wager(Kind.Bet, '100.00'), '100.00')).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('rejects insufficient funds', () => {
    expect(run(wager(Kind.Bet, '120.00'), '100.00')).toEqual({
      type: 'REJECT',
      code: FailureCode.InsufficientFunds,
    });
  });
});

describe('WIN', () => {
  test('credits without a reference', () => {
    expect(run(wager(Kind.Win, '50.00'), '0.00')).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('credits when referencing a processed bet of the same round', () => {
    const bet = processed(wager(Kind.Bet, '10.00'));
    expect(run(wager(Kind.Win, '30.00', refTo(bet)), '0.00', bet)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
    });
  });

  test('rejects a reference from another round', () => {
    const bet = processed(wager(Kind.Bet, '10.00', { roundId: 'round-2' }));
    expect(run(wager(Kind.Win, '30.00', refTo(bet)), '0.00', bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceMismatch,
    });
  });

  test('rejects a reference that is not a bet', () => {
    const other = processed(wager(Kind.Win, '10.00'));
    expect(run(wager(Kind.Win, '10.00', refTo(other)), '0.00', other)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceKindNotReversible,
    });
  });
});

describe('LOSS', () => {
  test('has no balance effect', () => {
    expect(run(wager(Kind.Loss, '0.00'), '10.00')).toEqual({ type: 'NO_EFFECT' });
  });
});

describe('REFUND', () => {
  test('credits a processed bet', () => {
    const bet = processed(wager(Kind.Bet, '25.00'));
    expect(run(wager(Kind.Refund, '25.00', refTo(bet)), '75.00', bet)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
    });
  });

  test('only refunds bets', () => {
    const win = processed(wager(Kind.Win, '25.00'));
    expect(run(wager(Kind.Refund, '25.00', refTo(win)), '75.00', win)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceKindNotReversible,
    });
  });

  test('requires the same amount as the reference', () => {
    const bet = processed(wager(Kind.Bet, '25.00'));
    expect(run(wager(Kind.Refund, '20.00', refTo(bet)), '75.00', bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.AmountMismatch,
    });
  });

  test('waits when the reference has not arrived', () => {
    expect(run(wager(Kind.Refund, '25.00', { referenceExternalTransactionId: 'ext-missing' }), '75.00')).toEqual({
      type: 'PENDING_REFERENCE',
    });
  });

  test('waits when the reference is not terminal yet', () => {
    const bet = wager(Kind.Bet, '25.00');
    expect(run(wager(Kind.Refund, '25.00', refTo(bet)), '75.00', bet)).toEqual({ type: 'PENDING_REFERENCE' });
  });

  test('rejects a reference that was itself rejected', () => {
    const bet = wager(Kind.Bet, '25.00');
    bet.reject(FailureCode.InsufficientFunds, brl('0.00'), t0);
    expect(run(wager(Kind.Refund, '25.00', refTo(bet)), '75.00', bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('rejects a second reversal of the same reference', () => {
    const bet = processed(wager(Kind.Bet, '25.00'));
    expect(run(wager(Kind.Refund, '25.00', refTo(bet)), '75.00', bet, true)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test('rejects a reference that belongs to another player', () => {
    const bet = processed(wager(Kind.Bet, '25.00', { playerId: 'player-2' }));
    expect(run(wager(Kind.Refund, '25.00', refTo(bet)), '75.00', bet)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceMismatch,
    });
  });
});

describe('ROLLBACK', () => {
  test('of a bet credits it back', () => {
    const bet = processed(wager(Kind.Bet, '25.00'));
    expect(run(wager(Kind.Rollback, '25.00', refTo(bet)), '75.00', bet)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
    });
  });

  test('of a refund debits it back', () => {
    const refund = processed(wager(Kind.Refund, '25.00', { referenceExternalTransactionId: 'ext-bet' }));
    expect(run(wager(Kind.Rollback, '25.00', refTo(refund)), '100.00', refund)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Debit,
    });
  });

  test('of a win without enough balance is rejected with a reversal-specific code', () => {
    const win = processed(wager(Kind.Win, '50.00'));
    expect(run(wager(Kind.Rollback, '50.00', refTo(win)), '10.00', win)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReversalInsufficientFunds,
    });
  });

  test('of a loss is not reversible', () => {
    const loss = processed(wager(Kind.Loss, '0.00'));
    expect(run(wager(Kind.Rollback, '1.00', refTo(loss)), '10.00', loss)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceKindNotReversible,
    });
  });

  test('of a rollback is not reversible', () => {
    const rollback = processed(wager(Kind.Rollback, '1.00', { referenceExternalTransactionId: 'ext-bet' }));
    expect(run(wager(Kind.Rollback, '1.00', refTo(rollback)), '10.00', rollback)).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceKindNotReversible,
    });
  });
});

describe('wallet-level checks', () => {
  test('currency must match the wallet', () => {
    const tx = wager(Kind.Bet, '1.00');
    expect(decide({ tx, wallet: walletWith('10.00', 'USD'), referenceAlreadyReversed: false })).toEqual({
      type: 'REJECT',
      code: FailureCode.CurrencyMismatch,
    });
  });

  test('player must own the wallet', () => {
    expect(run(wager(Kind.Bet, '1.00', { playerId: 'player-2' }), '10.00')).toEqual({
      type: 'REJECT',
      code: FailureCode.PlayerWalletMismatch,
    });
  });
});
