import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-entry';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-kind';
import {
  InvalidTransactionStateError,
  MissingReferenceError,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { brl, processed, t0, t1, wager } from './wager-fixtures';

describe('WagerTransaction.create', () => {
  test('starts pending', () => {
    const tx = wager(Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.attempts).toBe(0);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => wager(kind, '25.00')).toThrow(MissingReferenceError);
  });

  test('opening transactions cannot be created through the public factory', () => {
    expect(() => wager(Kind.Opening as never, '25.00')).toThrow(/OPENING/);
  });

  test('createOpening yields a processed internal credit', () => {
    const tx = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      now: t0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.idempotencyKey).toBe('opening:wallet-1');
    expect(tx.resultBalance?.equals(brl('1000.00'))).toBe(true);
  });
});

describe('state machine', () => {
  test('pending reference can later be processed', () => {
    const tx = wager(Kind.Refund, '25.00', { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(t1);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(t1);

    tx.markProcessed('tx-bet', brl('100.00'), t1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.processedAt).toEqual(t1);
  });

  test('terminal states reject any further transition', () => {
    const tx = processed(wager(Kind.Bet, '25.00'));
    expect(() => tx.markProcessed(undefined, brl('1.00'), t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed, t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(t1)).toThrow(InvalidTransactionStateError);
  });

  test('reject records the failure code and observed balance', () => {
    const tx = wager(Kind.Bet, '120.00');
    tx.reject(FailureCode.InsufficientFunds, brl('100.00'), t1);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultBalance?.equals(brl('100.00'))).toBe(true);
  });

  test('fail is terminal and auditable', () => {
    const tx = wager(Kind.Win, '10.00');
    tx.fail(FailureCode.ProcessingFailed, t1);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
  });
});

describe('domain queries', () => {
  test('LOSS does not affect balance', () => {
    expect(wager(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wager(Kind.Bet, '1.00').affectsBalance()).toBe(true);
  });

  test('payload matching is by hash', () => {
    const tx = wager(Kind.Bet, '1.00');
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('ledger direction per kind, rollback inverts the reference', () => {
    const bet = wager(Kind.Bet, '10.00');
    const win = wager(Kind.Win, '10.00');
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager(Kind.Refund, '10.00', { referenceExternalTransactionId: 'x' }).ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(MissingReferenceError);
  });
});
