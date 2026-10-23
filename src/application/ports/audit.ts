import type { JsonValue } from '../../domain/shared/canonical-json';

export type AuditSource = 'HTTP' | 'SQS' | 'WORKER';

export type AuditOperation = 'OPEN_WALLET' | 'SUBMIT_WAGER' | 'RETRY_PENDING_REFERENCE' | 'RECONCILE';

export type AuditOutcome =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'REPLAY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONTRACT_ERROR'
  | 'DLQ'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'DUPLICATE_MESSAGE';

export interface AuditEntry {
  source: AuditSource;
  actor: string;
  operation: AuditOperation;
  outcome: AuditOutcome;
  correlationId: string;
  occurredAt: Date;
  code?: string;
  messageId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  payload?: JsonValue;
  transactionId?: string;
  walletId?: string;
}
