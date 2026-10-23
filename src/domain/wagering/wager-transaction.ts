import { LedgerDirection } from '../ledger/ledger-entry';
import type { Money } from '../money/money';
import { canonicalJson, sha256Hex } from '../shared/canonical-json';
import { DomainError } from '../shared/domain-error';
import type { FailureCode } from './failure-code';
import { TERMINAL_STATUSES, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-kind';

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class MissingReferenceError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

export class OpeningNotAllowedError extends DomainError {
  readonly code = 'OPENING_NOT_ALLOWED';
}

export const OPENING_PROVIDER_ID = 'system';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

const REVERSAL_KINDS: ReadonlySet<Kind> = new Set([Kind.Refund, Kind.Rollback]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: Kind,
    public readonly money: Money,
    /** Provider-side id of the referenced transaction, not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: Status,
    private _attempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _nextAttemptAt?: Date,
  ) {}

  /** Starts PENDING. REFUND and ROLLBACK must name the transaction they reverse. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new OpeningNotAllowedError('OPENING is internal and cannot be submitted');
    }
    if (REVERSAL_KINDS.has(props.kind) && props.referenceExternalTransactionId === undefined) {
      throw new MissingReferenceError(`${props.kind} requires referenceExternalTransactionId`);
    }
    return WagerTransaction.rehydrate({ ...props, status: Status.Pending, attempts: 0 });
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    now: Date;
  }): WagerTransaction {
    const payloadHash = sha256Hex(
      canonicalJson({ walletId: props.walletId, playerId: props.playerId, money: { ...props.money.toJSON() } }),
    );
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: props.walletId,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: Kind.Opening,
      money: props.money,
      createdAt: props.now,
      status: Status.Processed,
      attempts: 0,
      processedAt: props.now,
      resultBalance: props.money,
    });
  }

  /** Rebuilds persisted state as-is; transitions are not revalidated. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.attempts,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.nextAttemptAt,
    );
  }

  get status(): Status {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Wallet balance observed when the transaction settled; replays return it unchanged. */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = Status.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, resultBalance: Money, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = Status.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = Status.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Opening:
      case Kind.Win:
      case Kind.Refund:
        return LedgerDirection.Credit;
      case Kind.Rollback:
        if (reference === undefined) {
          throw new MissingReferenceError('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      case Kind.Loss:
        throw new InvalidTransactionStateError('LOSS has no ledger direction');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${transition} on ${this.id} in terminal status ${this._status}`);
    }
  }
}
