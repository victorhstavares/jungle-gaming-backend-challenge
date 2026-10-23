import { HttpException } from '@nestjs/common';
import {
  ApplicationError,
  ContractError,
  IdempotencyConflictError,
  InvalidCursorError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import type { WagerResult } from '../../application/wagering/wager-result';
import { ForbiddenError, UnauthenticatedError } from './request-context';

/**
 * One status per situation, identical on every endpoint, so a provider can decide to resend without parsing
 * messages: 400 means fix the request, 409 means the key is taken, 422 is a final business answer,
 * 202 means accepted but waiting, 503 means retry the same request later.
 */
export function statusForWager(result: WagerResult): number {
  switch (result.outcome) {
    case 'PROCESSED':
      return 201;
    case 'PENDING_REFERENCE':
      return 202;
    case 'REJECTED':
      return 422;
    case 'FAILED':
      return 500;
    case 'DUPLICATE_MESSAGE':
      return 200;
  }
}

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: string;
  issues?: readonly { path: string; message: string }[];
  retryAfterSeconds?: number;
}

const FASTIFY_PROBLEMS: Record<string, { status: number; code: string; title: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE', title: 'Request body too large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'INVALID_PAYLOAD', title: 'Empty JSON body' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'INVALID_PAYLOAD', title: 'Invalid content length' },
};

const HTTP_STATUS_CODES: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  404: 'ROUTE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

export function problemFor(error: unknown): Problem {
  if (error instanceof ContractError) {
    return { status: 400, code: error.code, title: 'Invalid request', detail: error.message, issues: error.issues };
  }
  if (error instanceof InvalidCursorError) return { status: 400, code: error.code, title: 'Invalid cursor' };
  if (error instanceof UnauthenticatedError) return { status: 401, code: error.code, title: 'Authentication required' };
  if (error instanceof ForbiddenError) return { status: 403, code: error.code, title: 'Forbidden', detail: error.message };
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, code: error.code, title: 'Not found' };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, title: 'Conflict', detail: error.message };
  }
  if (error instanceof TransientInfrastructureError) {
    return { status: 503, code: error.code, title: 'Temporarily unavailable', retryAfterSeconds: 1 };
  }
  if (error instanceof ApplicationError) {
    return { status: 500, code: error.code, title: 'Internal error' };
  }

  const fastifyCode: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
  if (typeof fastifyCode === 'string' && fastifyCode in FASTIFY_PROBLEMS) {
    const known = FASTIFY_PROBLEMS[fastifyCode];
    if (known !== undefined) return known;
  }
  const statusCode: unknown = error instanceof Error ? Reflect.get(error, 'statusCode') : undefined;
  if (error instanceof SyntaxError || (typeof statusCode === 'number' && statusCode === 400)) {
    return { status: 400, code: 'INVALID_PAYLOAD', title: 'Malformed request body' };
  }
  const httpStatus = error instanceof HttpException ? error.getStatus() : undefined;
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return { status: httpStatus, code: HTTP_STATUS_CODES[httpStatus] ?? 'BAD_REQUEST', title: 'Request error' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', title: 'Internal error' };
}
