import type { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wagering-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-events';
import { CounterpartEntry, LedgerAccountType, LedgerDirection } from '../../domain/ledger/ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-kind';
import { decide, type Decision } from '../../domain/wagering/wager-rules';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { AuditRecorder } from '../audit/audit-recorder';
import {
  ApplicationError,
  IdempotencyConflictError,
  IntegrityViolationError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import { eventContextFactory } from '../event-context';
import type { AuditEntry, AuditOutcome, AuditSource } from '../ports/audit';
import type { Clock, IdGenerator } from '../ports/clock';
import type { Logger, Metrics } from '../ports/observability';
import type { TransactionRunner, TxRepositories } from '../ports/repositories';
import { PENDING_REFERENCE_MAX_ATTEMPTS, nextPendingAttemptAt } from './pending-reference-policy';
import type { WagerCommand } from './wager-command';
import { resultOf, type WagerResult } from './wager-result';

export interface WagerContext {
  source: AuditSource;
  actor: string;
  correlationId: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

const IDEMPOTENCY_CONSTRAINTS = new Set(['wager_tx_provider_idempotency_key', 'wager_tx_provider_external_key']);

interface Settlement {
  tx: WagerTransaction;
  wallet: Wallet;
  decision: Decision;
  reference: WagerTransaction | undefined;
  persist: (repos: TxRepositories, tx: WagerTransaction) => Promise<void>;
  now: Date;
  nextEventContext: () => EventContext;
}

/**
 * The single entry point for applying a wager, shared by HTTP, the SQS consumer and the pending-reference worker.
 * Everything a transaction changes (row, wallet, ledger, inbox, outbox, audit) commits in one SQL transaction
 * that holds the wallet row lock.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const started = performance.now();
    try {
      return await this.executeWithRetryOnRace(cmd, ctx);
    } catch (error) {
      return await this.handleFailure(error, cmd, ctx);
    } finally {
      this.metrics.observe('wager_processing_seconds', (performance.now() - started) / 1000, { source: ctx.source });
    }
  }

  /** Re-evaluates a PENDING_REFERENCE transaction. Lock order matches `execute`: wallet first, then transaction. */
  async reprocessPending(transactionId: string, ctx: WagerContext): Promise<WagerResult | undefined> {
    return this.runner.run({ correlationId: ctx.correlationId }, async (repos) => {
      const peek = await repos.transactions.findById(transactionId);
      if (peek?.status !== WagerTransactionStatus.PendingReference) {
        return peek === undefined ? undefined : resultOf(peek, true);
      }
      const wallet = await this.lockWallet(repos, peek.walletId);
      const tx = await repos.transactions.lockById(transactionId);
      if (wallet === undefined || tx?.status !== WagerTransactionStatus.PendingReference) {
        return tx === undefined ? undefined : resultOf(tx, true);
      }

      const now = this.clock.now();
      const { decision, reference } = await this.decideFor(repos, tx, wallet);
      const settlement: Settlement = {
        tx,
        wallet,
        decision,
        reference,
        now,
        persist: (r, t) => r.transactions.update(t),
        nextEventContext: eventContextFactory(this.ids, now, ctx.correlationId),
      };

      if (decision.type === 'PENDING_REFERENCE' && tx.attempts < PENDING_REFERENCE_MAX_ATTEMPTS) {
        tx.markPendingReference(nextPendingAttemptAt(now, tx.attempts));
        await repos.transactions.update(tx);
        this.metrics.increment('pending_reference_retries_total');
        return resultOf(tx, false);
      }
      const finalDecision: Decision =
        decision.type === 'PENDING_REFERENCE' ? { type: 'REJECT', code: FailureCode.ReferenceNotFound } : decision;
      const result = await this.settle(repos, { ...settlement, decision: finalDecision }, ctx, 'RETRY_PENDING_REFERENCE');
      this.logOutcome(tx, ctx, false);
      return result;
    });
  }

  private async executeWithRetryOnRace(cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    try {
      return await this.runner.run({ correlationId: ctx.correlationId }, (repos) => this.process(repos, cmd, ctx));
    } catch (error) {
      // Another request inserted the same key between our lookup and insert (different wallets, so no shared lock).
      // Running again finds that row and answers as a replay or a conflict.
      if (error instanceof UniqueViolationError && IDEMPOTENCY_CONSTRAINTS.has(error.constraint)) {
        return await this.runner.run({ correlationId: ctx.correlationId }, (repos) => this.process(repos, cmd, ctx));
      }
      throw error;
    }
  }

  private async process(repos: TxRepositories, cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const now = this.clock.now();

    let inboxMessage: InboxMessage | undefined;
    if (ctx.inbox !== undefined) {
      inboxMessage = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      if (!(await repos.inbox.tryReceive(inboxMessage))) {
        this.metrics.increment('inbox_duplicates_total');
        await repos.audit.record(this.auditEntry(cmd, ctx, now, 'DUPLICATE_MESSAGE'));
        return { outcome: 'DUPLICATE_MESSAGE', idempotentReplay: true };
      }
    }

    const wallet = await this.lockWallet(repos, cmd.walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(`Wallet ${cmd.walletId} does not exist`);
    }

    const existing =
      (await repos.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) ??
      (await repos.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId));
    if (existing !== undefined) {
      if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(cmd.payloadHash)) {
        throw new IdempotencyConflictError(
          `Idempotency key ${cmd.idempotencyKey} or external id ${cmd.externalTransactionId} was used with another payload`,
        );
      }
      await this.markInboxProcessed(repos, inboxMessage, now);
      await repos.audit.record({ ...this.auditEntry(cmd, ctx, now, 'REPLAY'), transactionId: existing.id });
      this.metrics.increment('idempotent_replays_total');
      this.logOutcome(existing, ctx, true);
      return resultOf(existing, true);
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      ...(cmd.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: cmd.referenceExternalTransactionId }),
      createdAt: now,
    });
    const { decision, reference } = await this.decideFor(repos, tx, wallet);
    const result = await this.settle(
      repos,
      {
        tx,
        wallet,
        decision,
        reference,
        now,
        persist: (r, t) => r.transactions.insert(t),
        nextEventContext: eventContextFactory(this.ids, now, ctx.correlationId, ctx.inbox?.messageId),
      },
      ctx,
      'SUBMIT_WAGER',
      cmd,
    );
    await this.markInboxProcessed(repos, inboxMessage, now);
    this.logOutcome(tx, ctx, false);
    return result;
  }

  private async decideFor(
    repos: TxRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
  ): Promise<{ decision: Decision; reference: WagerTransaction | undefined }> {
    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (reference !== undefined && tx.requiresReference()) {
        referenceAlreadyReversed = await repos.transactions.isReversed(reference.id);
      }
    }
    const decision = decide({ tx, wallet, referenceAlreadyReversed, ...(reference === undefined ? {} : { reference }) });
    return { decision, reference };
  }

  private async settle(
    repos: TxRepositories,
    s: Settlement,
    ctx: WagerContext,
    operation: AuditEntry['operation'],
    cmd?: WagerCommand,
  ): Promise<WagerResult> {
    const { tx, wallet, decision, now } = s;
    const outbox: OutboxMessage[] = [];
    let outcome: AuditOutcome;

    switch (decision.type) {
      case 'APPLY': {
        const entryId = this.ids.next();
        const entry =
          decision.direction === LedgerDirection.Debit
            ? wallet.debit(tx.money, tx.id, entryId, now)
            : wallet.credit(tx.money, tx.id, entryId, now);
        tx.markProcessed(s.reference?.id, wallet.balance, now);
        await s.persist(repos, tx);
        await repos.wallets.update(wallet);
        await repos.ledger.insert(
          entry,
          CounterpartEntry.for(
            entry,
            LedgerAccountType.ProviderClearing,
            `${tx.providerId}:${tx.money.currency}`,
            this.ids.next(),
          ),
        );
        outbox.push(
          OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, s.nextEventContext())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, s.nextEventContext())),
        );
        outcome = 'PROCESSED';
        break;
      }
      case 'NO_EFFECT':
        tx.markProcessed(s.reference?.id, wallet.balance, now);
        await s.persist(repos, tx);
        outbox.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, s.nextEventContext())));
        outcome = 'PROCESSED';
        break;
      case 'REJECT':
        tx.reject(decision.code, wallet.balance, now);
        await s.persist(repos, tx);
        outbox.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, s.nextEventContext())));
        outcome = 'REJECTED';
        break;
      case 'PENDING_REFERENCE':
        tx.markPendingReference(nextPendingAttemptAt(now, tx.attempts));
        await s.persist(repos, tx);
        outbox.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, s.nextEventContext())));
        outcome = 'PENDING_REFERENCE';
        break;
    }

    if (tx.status === WagerTransactionStatus.Processed) {
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
    }
    await repos.outbox.enqueue(outbox);
    await repos.audit.record({
      ...(cmd === undefined ? this.auditEntryFor(tx, ctx, now, outcome) : this.auditEntry(cmd, ctx, now, outcome)),
      operation,
      transactionId: tx.id,
      ...(tx.failureCode === undefined ? {} : { code: tx.failureCode }),
    });
    this.metrics.increment('wager_transactions_total', { kind: tx.kind, status: tx.status });
    return resultOf(tx, false);
  }

  private async handleFailure(error: unknown, cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const now = this.clock.now();
    if (error instanceof IdempotencyConflictError) {
      this.metrics.increment('idempotency_conflicts_total');
      await this.audit.recordOutside({ ...this.auditEntry(cmd, ctx, now, 'IDEMPOTENCY_CONFLICT'), code: error.code });
      throw error;
    }
    if (error instanceof WalletNotFoundError) {
      await this.audit.recordOutside({ ...this.auditEntry(cmd, ctx, now, 'NOT_FOUND'), code: error.code });
      throw error;
    }
    if (error instanceof TransientInfrastructureError) {
      if (error.reason === 'lock_timeout') this.metrics.increment('wallet_lock_timeouts_total');
      this.logger.warn(
        { ...this.logFields(cmd, ctx), reason: error.reason, err: error },
        'wager processing hit a transient failure',
      );
      throw error;
    }
    // Only a proven integrity violation is permanent. Anything unclassified is surfaced so the caller retries with
    // the same key; turning it into a terminal FAILED could lose a bet that would succeed on the next attempt.
    if (error instanceof IntegrityViolationError) {
      return this.recordFailed(error, cmd, ctx, now);
    }
    if (error instanceof UniqueViolationError && IDEMPOTENCY_CONSTRAINTS.has(error.constraint)) {
      throw new TransientInfrastructureError('Concurrent request with the same key; retry', { cause: error, reason: 'conflict' });
    }
    if (error instanceof UniqueViolationError) {
      return this.recordFailed(error, cmd, ctx, now);
    }
    if (!(error instanceof ApplicationError)) {
      this.logger.error({ ...this.logFields(cmd, ctx), err: error }, 'wager processing failed with an unexpected error');
    }
    throw error;
  }

  /**
   * A permanent infrastructure error (an integrity trigger fired, a value overflowed) rolled the attempt back.
   * Record the transaction as FAILED in a fresh transaction so the provider and auditors see a final answer.
   */
  private async recordFailed(error: unknown, cmd: WagerCommand, ctx: WagerContext, now: Date): Promise<WagerResult> {
    this.metrics.increment('processing_failures_total');
    this.logger.error({ ...this.logFields(cmd, ctx), err: error }, 'wager processing failed permanently');
    try {
      return await this.runner.run({ correlationId: ctx.correlationId }, async (repos) => {
        const existing =
          (await repos.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) ??
          (await repos.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId));
        if (existing !== undefined) {
          if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(cmd.payloadHash)) {
            throw new IdempotencyConflictError(
              `Idempotency key ${cmd.idempotencyKey} or external id ${cmd.externalTransactionId} was used with another payload`,
            );
          }
          await repos.audit.record({ ...this.auditEntry(cmd, ctx, now, 'REPLAY'), transactionId: existing.id });
          return resultOf(existing, true);
        }

        const tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash: cmd.payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money: cmd.money,
          ...(cmd.referenceExternalTransactionId === undefined
            ? {}
            : { referenceExternalTransactionId: cmd.referenceExternalTransactionId }),
          createdAt: now,
        });
        tx.fail(FailureCode.ProcessingFailed, now);
        await repos.transactions.insert(tx);
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(
            WagerTransactionRejected.from(tx, eventContextFactory(this.ids, now, ctx.correlationId, ctx.inbox?.messageId)()),
          ),
        ]);
        await repos.audit.record({
          ...this.auditEntry(cmd, ctx, now, 'FAILED'),
          code: FailureCode.ProcessingFailed,
          transactionId: tx.id,
        });
        this.metrics.increment('wager_transactions_total', { kind: tx.kind, status: tx.status });
        return resultOf(tx, false);
      });
    } catch (recordError) {
      if (recordError instanceof IdempotencyConflictError) {
        this.metrics.increment('idempotency_conflicts_total');
        await this.audit.recordOutside({ ...this.auditEntry(cmd, ctx, now, 'IDEMPOTENCY_CONFLICT'), code: recordError.code });
        throw recordError;
      }
      this.logger.error({ ...this.logFields(cmd, ctx), err: recordError }, 'could not record FAILED transaction');
      throw error;
    }
  }

  private async lockWallet(repos: TxRepositories, walletId: string): Promise<Wallet | undefined> {
    const started = performance.now();
    const wallet = await repos.wallets.lockById(walletId);
    this.metrics.observe('wallet_lock_wait_seconds', (performance.now() - started) / 1000);
    return wallet;
  }

  private async markInboxProcessed(repos: TxRepositories, message: InboxMessage | undefined, now: Date): Promise<void> {
    if (message === undefined) return;
    message.markProcessed(now);
    await repos.inbox.markProcessed(message);
  }

  private auditEntry(cmd: WagerCommand, ctx: WagerContext, now: Date, outcome: AuditOutcome): AuditEntry {
    return {
      source: ctx.source,
      actor: ctx.actor,
      operation: ctx.source === 'WORKER' ? 'RETRY_PENDING_REFERENCE' : 'SUBMIT_WAGER',
      outcome,
      correlationId: ctx.correlationId,
      occurredAt: now,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      payload: {
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        playerId: cmd.playerId,
        walletId: cmd.walletId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money: { ...cmd.money.toJSON() },
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      },
      ...(ctx.inbox === undefined ? {} : { messageId: ctx.inbox.messageId }),
    };
  }

  private auditEntryFor(tx: WagerTransaction, ctx: WagerContext, now: Date, outcome: AuditOutcome): AuditEntry {
    return {
      source: ctx.source,
      actor: ctx.actor,
      operation: 'RETRY_PENDING_REFERENCE',
      outcome,
      correlationId: ctx.correlationId,
      occurredAt: now,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
    };
  }

  private logFields(cmd: WagerCommand, ctx: WagerContext): Record<string, unknown> {
    return {
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      providerId: cmd.providerId,
      walletId: cmd.walletId,
      externalTransactionId: cmd.externalTransactionId,
      kind: cmd.kind,
      source: ctx.source,
    };
  }

  private logOutcome(tx: WagerTransaction, ctx: WagerContext, replay: boolean): void {
    this.logger.info(
      {
        correlationId: ctx.correlationId,
        messageId: ctx.inbox?.messageId,
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        replay,
        source: ctx.source,
      },
      'wager transaction settled',
    );
  }
}
