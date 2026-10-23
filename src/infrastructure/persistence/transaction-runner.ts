import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  IntegrityViolationError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../application/errors';
import type { TransactionContext, TransactionRunner, TxRepositories } from '../../application/ports/repositories';
import { classifyDbError } from './pg-errors';
import { MikroOrmAuditRepository, MikroOrmReconciliationRepository } from './repositories/audit.repository';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository';
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from './repositories/messaging.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';

export interface TransactionRunnerOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export function repositoriesFor(em: EntityManager): TxRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    audit: new MikroOrmAuditRepository(em),
    reconciliations: new MikroOrmReconciliationRepository(em),
  };
}

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: TransactionRunnerOptions,
  ) {}

  async run<T>(ctx: TransactionContext, work: (repos: TxRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.transactional(ctx, work);
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private transactional<T>(ctx: TransactionContext, work: (repos: TxRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      // Scoped to this transaction: a stuck lock fails fast, and triggers can read the correlation id for history rows.
      await em.execute(
        `SELECT set_config('app.correlation_id', ?, true),
                set_config('lock_timeout', ?, true),
                set_config('statement_timeout', ?, true)`,
        [ctx.correlationId, `${this.options.lockTimeoutMs}ms`, `${this.options.statementTimeoutMs}ms`],
      );
      return work(repositoriesFor(em));
    });
  }
}

/** Driver errors become application errors here, so use cases never depend on Postgres error codes. */
export function translateDbError(error: unknown): unknown {
  const failure = classifyDbError(error);
  switch (failure.kind) {
    case 'transient':
      return new TransientInfrastructureError('Database temporarily unavailable', { cause: error, reason: failure.reason });
    case 'unique':
      return new UniqueViolationError(failure.constraint, { cause: error });
    case 'integrity':
      return new IntegrityViolationError(failure.detail, { cause: error });
    case 'unknown':
      return error;
  }
}
