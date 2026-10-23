import type { LedgerDirection, WalletLedgerEntry } from '../ledger/ledger-entry';
import type { MoneyProps } from '../money/money';
import type { Wallet } from '../wallet/wallet';
import { IntegrationEvent, type EventContext } from './integration-event';

export interface WalletOpenedData {
  walletId: string;
  playerId: string;
  balance: MoneyProps;
  walletVersion: number;
}

export class WalletOpened extends IntegrationEvent<WalletOpenedData> {
  readonly eventType = 'WalletOpened';
  readonly version = 1;

  static from(wallet: Wallet, ctx: EventContext): WalletOpened {
    return new WalletOpened({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
