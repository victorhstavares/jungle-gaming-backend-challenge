import { LedgerDirection, WalletLedgerEntry } from '../ledger/ledger-entry';
import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  openingTransactionId: string;
  openingEntryId: string;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.now, props.now);
    if (!props.initialBalance.isPositive()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state as-is; transitions are not revalidated. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(`Balance ${this._balance.toString()} cannot cover ${money.toString()}`);
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, entryId, now);
  }

  credit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, entryId, now);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    entryId: string,
    now: Date,
  ): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: now,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet ${this.id} holds ${this.currency}, got ${money.currency}`);
    }
  }
}
