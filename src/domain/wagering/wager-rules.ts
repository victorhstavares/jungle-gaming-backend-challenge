import { LedgerDirection } from '../ledger/ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-kind';
import type { WagerTransaction } from './wager-transaction';

export interface DecideInput {
  tx: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
}

export type Decision =
  | { type: 'APPLY'; direction: LedgerDirection }
  | { type: 'NO_EFFECT' }
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'PENDING_REFERENCE' };

const ALLOWED_REFERENCES: Readonly<Record<Kind, ReadonlySet<Kind>>> = {
  [Kind.Opening]: new Set(),
  [Kind.Bet]: new Set(),
  [Kind.Win]: new Set([Kind.Bet]),
  [Kind.Loss]: new Set([Kind.Bet]),
  [Kind.Refund]: new Set([Kind.Bet]),
  [Kind.Rollback]: new Set([Kind.Bet, Kind.Win, Kind.Refund]),
};

const reject = (code: FailureCode): Decision => ({ type: 'REJECT', code });

/**
 * Pure decision for a transaction against a locked wallet. The caller guarantees
 * the wallet row is locked and that `reference` was resolved by (providerId, referenceExternalTransactionId).
 */
export function decide({ tx, wallet, reference, referenceAlreadyReversed }: DecideInput): Decision {
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) return reject(FailureCode.PlayerWalletMismatch);

  if (tx.requiresReference() || tx.referenceExternalTransactionId !== undefined) {
    const referenceDecision = checkReference(tx, reference, referenceAlreadyReversed);
    if (referenceDecision !== undefined) return referenceDecision;
  }

  if (!tx.affectsBalance()) return { type: 'NO_EFFECT' };

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
    return reject(tx.kind === Kind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
  }
  return { type: 'APPLY', direction };
}

function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  referenceAlreadyReversed: boolean,
): Decision | undefined {
  if (reference === undefined || !reference.isTerminal()) return { type: 'PENDING_REFERENCE' };
  if (reference.status !== Status.Processed) return reject(FailureCode.ReferenceNotProcessed);

  const sameScope =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameScope) return reject(FailureCode.ReferenceMismatch);

  if (!ALLOWED_REFERENCES[tx.kind].has(reference.kind)) return reject(FailureCode.ReferenceKindNotReversible);

  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) return reject(FailureCode.AmountMismatch);
    if (referenceAlreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
  }
  return undefined;
}
