import { DomainError } from '../shared/domain-error';
import type { Money } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export enum LedgerAccountType {
  Wallet = 'WALLET',
  ProviderClearing = 'PROVIDER_CLEARING',
  SystemOpening = 'SYSTEM_OPENING',
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

/** Immutable wallet-side posting. Its arithmetic is checked once, at creation. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError('Ledger amount must be positive');
    }
    if (props.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('Ledger entry would leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError('balanceBefore ± money must equal balanceAfter');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

/**
 * The other leg of the double entry. It has no running balance, because
 * a balance column on a shared clearing account would become a hot row that every wallet contends on.
 */
export class CounterpartEntry {
  private constructor(
    public readonly id: string,
    public readonly transactionId: string,
    public readonly accountType: LedgerAccountType,
    public readonly accountId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly createdAt: Date,
  ) {}

  static for(
    entry: WalletLedgerEntry,
    accountType: LedgerAccountType.ProviderClearing | LedgerAccountType.SystemOpening,
    accountId: string,
    id: string,
  ): CounterpartEntry {
    const direction = entry.direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    return new CounterpartEntry(id, entry.transactionId, accountType, accountId, direction, entry.money, entry.createdAt);
  }
}
