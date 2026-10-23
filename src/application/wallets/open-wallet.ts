import { WalletBalanceChanged, WalletOpened } from '../../domain/events/wallet-events';
import { CounterpartEntry, LedgerAccountType } from '../../domain/ledger/ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { AuditRecorder } from '../audit/audit-recorder';
import { ContractError, UniqueViolationError, WalletAlreadyExistsError, isDomainError } from '../errors';
import { eventContextFactory } from '../event-context';
import type { AuditEntry } from '../ports/audit';
import type { Clock, IdGenerator } from '../ports/clock';
import type { TransactionRunner } from '../ports/repositories';
import { toWalletView, type WalletView } from './wallet-view';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  actor: string;
  correlationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly supportedCurrencies: ReadonlySet<string>,
  ) {}

  async execute(input: OpenWalletInput): Promise<WalletView> {
    const now = this.clock.now();
    const auditBase = {
      source: 'HTTP',
      actor: input.actor,
      operation: 'OPEN_WALLET',
      correlationId: input.correlationId,
      occurredAt: now,
      payload: { playerId: input.playerId, initialBalance: { ...input.initialBalance } },
    } satisfies Partial<AuditEntry>;

    let initialBalance: Money;
    try {
      if (!UUID.test(input.playerId)) {
        throw new ContractError('INVALID_PAYLOAD', 'playerId must be a UUID', [{ path: 'playerId', message: 'uuid' }]);
      }
      initialBalance = Money.from(input.initialBalance, this.supportedCurrencies);
    } catch (error) {
      const contractError = isDomainError(error) ? ContractError.fromDomain(error, 'initialBalance') : error;
      if (contractError instanceof ContractError) {
        await this.audit.recordOutside({ ...auditBase, outcome: 'CONTRACT_ERROR', code: contractError.code });
      }
      throw contractError;
    }

    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();
    const nextEventContext = eventContextFactory(this.ids, now, input.correlationId);

    try {
      return await this.runner.run({ correlationId: input.correlationId }, async (repos) => {
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: input.playerId,
          initialBalance,
          now,
          openingTransactionId,
          openingEntryId: this.ids.next(),
        });
        await repos.wallets.insert(wallet);

        const outbox = [OutboxMessage.enqueue(WalletOpened.from(wallet, nextEventContext()))];
        if (openingEntry !== undefined) {
          await repos.transactions.insert(
            WagerTransaction.createOpening({
              id: openingTransactionId,
              walletId,
              playerId: input.playerId,
              money: initialBalance,
              now,
            }),
          );
          await repos.ledger.insert(
            openingEntry,
            CounterpartEntry.for(openingEntry, LedgerAccountType.SystemOpening, initialBalance.currency, this.ids.next()),
          );
          outbox.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, nextEventContext())));
        }
        await repos.outbox.enqueue(outbox);
        await repos.audit.record({
          ...auditBase,
          outcome: 'PROCESSED',
          walletId,
          ...(openingEntry === undefined ? {} : { transactionId: openingTransactionId }),
        });
        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_key') {
        await this.audit.recordOutside({ ...auditBase, outcome: 'CONTRACT_ERROR', code: 'WALLET_ALREADY_EXISTS' });
        throw new WalletAlreadyExistsError(`Player ${input.playerId} already has a ${initialBalance.currency} wallet`);
      }
      throw error;
    }
  }
}
