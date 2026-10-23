import { DomainError } from '../domain/shared/domain-error';

/** Errors the application surfaces to its callers; `code` is part of the public contract. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ContractIssue {
  path: string;
  message: string;
}

export class ContractError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: readonly ContractIssue[] = [],
  ) {
    super(message);
  }

  static fromDomain(error: DomainError, path: string): ContractError {
    return new ContractError(error.code, error.message, [{ path, message: error.message }]);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** A queue message id seen before arrived with different content: a producer bug, parked for inspection. */
export class InboxConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_REUSED';
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
}

/** Postgres or SQS briefly unavailable, a lock wait timed out: safe to retry with the same idempotency key. */
export class TransientInfrastructureError extends ApplicationError {
  readonly reason: 'lock_timeout' | 'conflict' | 'connection';

  readonly code = 'TEMPORARILY_UNAVAILABLE';

  constructor(
    message: string,
    options?: { cause?: unknown; reason?: 'lock_timeout' | 'conflict' | 'connection' },
  ) {
    super(message);
    this.reason = options?.reason ?? 'connection';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** What a violated UNIQUE constraint protects, so use cases react without knowing constraint names. */
export type UniqueTarget = 'idempotency' | 'wallet-identity' | 'other';

/** A UNIQUE constraint rejected the write; `target` says what it protects, `constraint` names it for logs. */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(
    readonly constraint: string,
    readonly target: UniqueTarget,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated: ${constraint}`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A CHECK, foreign key or integrity trigger rejected the write: a bug or corrupted data, never retryable. */
export class IntegrityViolationError extends ApplicationError {
  readonly code = 'INTEGRITY_VIOLATION';

  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
