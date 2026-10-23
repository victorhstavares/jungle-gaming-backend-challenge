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
  InboxConflictError,
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

type Persist = (repos: TxRepositories, tx: WagerTransaction) => Promise<void>;
type Operation = AuditEntry['operation'];

const insertTx: Persist = (repos, tx) => repos.transactions.insert(tx);
const updateTx: Persist = (repos, tx) => repos.transactions.update(tx);

interface Settlement {
  tx: WagerTransaction;
  wallet: Wallet;
  decision: Decision;
  reference: WagerTransaction | undefined;
  persist: Persist;
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
      const locked = await this.lockPending(repos, transactionId);
      if (locked.kind === 'settled') return locked.result;
      const { tx, wallet } = locked;

      const now = this.clock.now();
      const { decision, reference } = await this.decideFor(repos, tx, wallet);
      const outOfAttempts = decision.type === 'PENDING_REFERENCE' && tx.attempts >= PENDING_REFERENCE_MAX_ATTEMPTS;
      // A reference that exists but never settled is reported differently from one never seen.
      const exhausted = reference === undefined ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
      const finalDecision: Decision = outOfAttempts ? { type: 'REJECT', code: exhausted } : decision;
      if (finalDecision.type === 'PENDING_REFERENCE') this.metrics.increment('pending_reference_retries_total');

      const result = await this.settle(
        repos,
        {
          tx,
          wallet,
          decision: finalDecision,
          reference,
          now,
          persist: updateTx,
          nextEventContext: eventContextFactory(this.ids, now, ctx.correlationId),
        },
        ctx,
        'RETRY_PENDING_REFERENCE',
      );
      this.logOutcome(tx, ctx, false);
      return result;
    });
  }

  /**
   * Marks a PENDING_REFERENCE transaction FAILED after a permanent error while reprocessing it, so the worker
   * stops re-claiming a row that can never settle. No balance or ledger change.
   */
  async failPending(transactionId: string, ctx: WagerContext, cause: unknown): Promise<void> {
    this.metrics.increment('processing_failures_total');
    this.logger.error({ err: cause, transactionId, correlationId: ctx.correlationId }, 'pending transaction failed permanently');
    await this.runner.run({ correlationId: ctx.correlationId }, async (repos) => {
      const locked = await this.lockPending(repos, transactionId);
      if (locked.kind === 'pending') {
        await this.markFailed(repos, locked.tx, ctx, this.clock.now(), updateTx, 'RETRY_PENDING_REFERENCE');
      }
    });
  }

  private async executeWithRetryOnRace(cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    try {
      return await this.runner.run({ correlationId: ctx.correlationId }, (repos) => this.process(repos, cmd, ctx));
    } catch (error) {
      // Another request inserted the same key between our lookup and insert (different wallets, so no shared lock).
      // Running again finds that row and answers as a replay or a conflict.
      if (error instanceof UniqueViolationError && error.target === 'idempotency') {
        return await this.runner.run({ correlationId: ctx.correlationId }, (repos) => this.process(repos, cmd, ctx));
      }
      throw error;
    }
  }

  private async process(repos: TxRepositories, cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    let now = this.clock.now();

    let inboxMessage: InboxMessage | undefined;
    if (ctx.inbox !== undefined) {
      inboxMessage = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      if (!(await repos.inbox.tryReceive(inboxMessage))) {
        const storedHash = await repos.inbox.payloadHashOf(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (storedHash !== ctx.inbox.payloadHash) {
          throw new InboxConflictError(`Message ${ctx.inbox.messageId} was already received with different content`);
        }
        this.metrics.increment('inbox_duplicates_total');
        await repos.audit.record(this.auditEntry(cmd, ctx, now, 'DUPLICATE_MESSAGE'));
        return { outcome: 'DUPLICATE_MESSAGE', idempotentReplay: true };
      }
    }

    const wallet = await this.lockWallet(repos, cmd.walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(`Wallet ${cmd.walletId} does not exist`);
    }
    now = this.clock.now();

    const existing = await this.findExistingOrConflict(repos, cmd);
    if (existing !== undefined) {
      await this.markInboxProcessed(repos, inboxMessage, now);
      return this.replay(repos, existing, cmd, ctx, now);
    }

    const tx = this.newTransaction(cmd, now);
    const { decision, reference } = await this.decideFor(repos, tx, wallet);
    const result = await this.settle(
      repos,
      {
        tx,
        wallet,
        decision,
        reference,
        now,
        persist: insertTx,
        nextEventContext: eventContextFactory(this.ids, now, ctx.correlationId, ctx.inbox?.messageId),
      },
      ctx,
      'SUBMIT_WAGER',
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

  private async settle(repos: TxRepositories, s: Settlement, ctx: WagerContext, operation: Operation): Promise<WagerResult> {
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
        // Announced once, when the wait starts; later retries are visible in the audit and status history.
        if (tx.attempts === 1) {
          outbox.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, s.nextEventContext())));
        }
        outcome = 'PENDING_REFERENCE';
        break;
    }

    if (tx.status === WagerTransactionStatus.Processed) {
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
    }
    await repos.outbox.enqueue(outbox);
    await repos.audit.record({
      ...this.auditFromTx(tx, ctx, now, outcome, operation),
      ...(tx.failureCode === undefined ? {} : { code: tx.failureCode }),
    });
    if (outcome !== 'PENDING_REFERENCE' || tx.attempts === 1) {
      this.metrics.increment('wager_transactions_total', { kind: tx.kind, status: tx.status });
    }
    return resultOf(tx, false);
  }

  private async handleFailure(error: unknown, cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const now = this.clock.now();
    if (error instanceof IdempotencyConflictError) {
      await this.auditConflict(error, cmd, ctx, now);
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
    if (error instanceof UniqueViolationError && error.target === 'idempotency') {
      throw new TransientInfrastructureError('Concurrent request with the same key; retry', { cause: error, reason: 'conflict' });
    }
    // Permanent: an integrity trigger or CHECK fired, or a UNIQUE that is not about idempotency was hit.
    // Anything unclassified is surfaced instead, so the caller retries with the same key; turning it into a
    // terminal FAILED could lose a bet that would succeed on the next attempt.
    if (error instanceof IntegrityViolationError || error instanceof UniqueViolationError) {
      return this.recordFailed(error, cmd, ctx, now);
    }
    if (!(error instanceof ApplicationError)) {
      this.logger.error({ ...this.logFields(cmd, ctx), err: error }, 'wager processing failed with an unexpected error');
    }
    throw error;
  }

  /**
   * A permanent infrastructure error rolled the attempt back. Record the transaction as FAILED in a fresh
   * transaction so the provider and auditors see a final answer.
   */
  private async recordFailed(error: unknown, cmd: WagerCommand, ctx: WagerContext, now: Date): Promise<WagerResult> {
    this.metrics.increment('processing_failures_total');
    this.logger.error({ ...this.logFields(cmd, ctx), err: error }, 'wager processing failed permanently');
    try {
      return await this.runner.run({ correlationId: ctx.correlationId }, async (repos) => {
        const existing = await this.findExistingOrConflict(repos, cmd);
        if (existing !== undefined) return this.replay(repos, existing, cmd, ctx, now);
        return this.markFailed(repos, this.newTransaction(cmd, now), ctx, now, insertTx, 'SUBMIT_WAGER');
      });
    } catch (recordError) {
      if (recordError instanceof IdempotencyConflictError) {
        await this.auditConflict(recordError, cmd, ctx, now);
        throw recordError;
      }
      this.logger.error({ ...this.logFields(cmd, ctx), err: recordError }, 'could not record FAILED transaction');
      throw error;
    }
  }

  private async markFailed(
    repos: TxRepositories,
    tx: WagerTransaction,
    ctx: WagerContext,
    now: Date,
    persist: Persist,
    operation: Operation,
  ): Promise<WagerResult> {
    tx.fail(FailureCode.ProcessingFailed, now);
    await persist(repos, tx);
    await repos.outbox.enqueue([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, eventContextFactory(this.ids, now, ctx.correlationId, ctx.inbox?.messageId)()),
      ),
    ]);
    await repos.audit.record({ ...this.auditFromTx(tx, ctx, now, 'FAILED', operation), code: FailureCode.ProcessingFailed });
    this.metrics.increment('wager_transactions_total', { kind: tx.kind, status: tx.status });
    return resultOf(tx, false);
  }

  /** The stored transaction for this key or external id, if any; a different payload under either is a conflict. */
  private async findExistingOrConflict(repos: TxRepositories, cmd: WagerCommand): Promise<WagerTransaction | undefined> {
    const existing =
      (await repos.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) ??
      (await repos.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId));
    if (existing !== undefined && (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(cmd.payloadHash))) {
      throw new IdempotencyConflictError(
        `Idempotency key ${cmd.idempotencyKey} or external id ${cmd.externalTransactionId} was used with another payload`,
      );
    }
    return existing;
  }

  private async replay(
    repos: TxRepositories,
    existing: WagerTransaction,
    cmd: WagerCommand,
    ctx: WagerContext,
    now: Date,
  ): Promise<WagerResult> {
    await repos.audit.record({ ...this.auditEntry(cmd, ctx, now, 'REPLAY'), transactionId: existing.id });
    this.metrics.increment('idempotent_replays_total');
    this.logOutcome(existing, ctx, true);
    return resultOf(existing, true);
  }

  private newTransaction(cmd: WagerCommand, now: Date): WagerTransaction {
    return WagerTransaction.create({
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
  }

  private async lockPending(
    repos: TxRepositories,
    transactionId: string,
  ): Promise<{ kind: 'pending'; tx: WagerTransaction; wallet: Wallet } | { kind: 'settled'; result: WagerResult | undefined }> {
    const peek = await repos.transactions.findById(transactionId);
    if (peek?.status !== WagerTransactionStatus.PendingReference) {
      return { kind: 'settled', result: peek === undefined ? undefined : resultOf(peek, true) };
    }
    const wallet = await this.lockWallet(repos, peek.walletId);
    const tx = await repos.transactions.lockById(transactionId);
    if (wallet === undefined || tx?.status !== WagerTransactionStatus.PendingReference) {
      return { kind: 'settled', result: tx === undefined ? undefined : resultOf(tx, true) };
    }
    return { kind: 'pending', tx, wallet };
  }

  private async auditConflict(error: IdempotencyConflictError, cmd: WagerCommand, ctx: WagerContext, now: Date): Promise<void> {
    this.metrics.increment('idempotency_conflicts_total');
    await this.audit.recordOutside({ ...this.auditEntry(cmd, ctx, now, 'IDEMPOTENCY_CONFLICT'), code: error.code });
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

  /** For attempts that never became a transaction: duplicates, replays, conflicts, unknown wallets. */
  private auditEntry(cmd: WagerCommand, ctx: WagerContext, now: Date, outcome: AuditOutcome): AuditEntry {
    return {
      source: ctx.source,
      actor: ctx.actor,
      operation: 'SUBMIT_WAGER',
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

  private auditFromTx(
    tx: WagerTransaction,
    ctx: WagerContext,
    now: Date,
    outcome: AuditOutcome,
    operation: Operation,
  ): AuditEntry {
    return {
      source: ctx.source,
      actor: ctx.actor,
      operation,
      outcome,
      correlationId: ctx.correlationId,
      occurredAt: now,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      transactionId: tx.id,
      payload: {
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: { ...tx.money.toJSON() },
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      },
      ...(ctx.inbox === undefined ? {} : { messageId: ctx.inbox.messageId }),
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
