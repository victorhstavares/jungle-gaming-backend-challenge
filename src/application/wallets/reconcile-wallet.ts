import { Money, type MoneyProps } from '../../domain/money/money';
import { WalletNotFoundError } from '../errors';
import type { Clock, IdGenerator } from '../ports/clock';
import type { Logger, Metrics } from '../ports/observability';
import type { TransactionRunner } from '../ports/repositories';

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Rebuilds the balance from the ledger and compares it with the stored one. Divergences are logged, counted
 * and recorded, never corrected here: fixing money silently would hide the bug that caused the drift.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, actor: string, correlationId: string): Promise<ReconciliationView> {
    return this.runner.run({ correlationId }, async (repos) => {
      // The row lock keeps writers out while both numbers are read, so they describe the same instant.
      const wallet = await repos.wallets.lockById(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${walletId} does not exist`);

      const { balanceMinor, entries } = await repos.ledger.sumForWallet(walletId);
      const stored = wallet.balance;
      const calculated = Money.ofMinor(balanceMinor, wallet.currency);
      const difference = stored.subtract(calculated);
      const consistent = difference.isZero();
      const now = this.clock.now();

      await repos.reconciliations.record({
        id: this.ids.next(),
        walletId,
        actor,
        correlationId,
        stored,
        calculated,
        checkedEntries: entries,
        checkedAt: now,
      });
      await repos.audit.record({
        source: 'HTTP',
        actor,
        operation: 'RECONCILE',
        outcome: 'PROCESSED',
        correlationId,
        occurredAt: now,
        walletId,
        ...(consistent ? {} : { code: 'BALANCE_MISMATCH' }),
      });

      if (!consistent) {
        this.metrics.increment('reconciliation_mismatches_total');
        this.logger.error(
          {
            correlationId,
            walletId,
            storedMinor: stored.toMinor().toString(),
            calculatedMinor: calculated.toMinor().toString(),
            checkedEntries: entries,
          },
          'wallet balance diverges from its ledger',
        );
      }

      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries,
      };
    });
  }
}
