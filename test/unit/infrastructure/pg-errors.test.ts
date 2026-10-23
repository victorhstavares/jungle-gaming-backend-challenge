import { describe, expect, test } from 'bun:test';
import { classifyDbError } from '../../../src/infrastructure/persistence/pg-errors';

const pgError = (code: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`pg ${code}`), { code, ...extra });

describe('classifyDbError', () => {
  test.each([
    ['08006', 'connection'],
    ['08001', 'connection'],
    ['57P01', 'connection'],
    ['ECONNREFUSED', 'connection'],
    ['ECONNRESET', 'connection'],
    ['ETIMEDOUT', 'connection'],
    ['40001', 'conflict'],
    ['40P01', 'conflict'],
    ['55P03', 'lock_timeout'],
    ['57014', 'lock_timeout'],
  ] as const)('%s is transient (%s)', (code, reason) => {
    expect(classifyDbError(pgError(code))).toEqual({ kind: 'transient', reason });
  });

  test.each(['Connection terminated unexpectedly', 'Query read timeout', 'timeout exceeded when trying to connect'])(
    'code-less driver error %p is a transient connection failure',
    (message) => {
      expect(classifyDbError(new Error(message))).toEqual({ kind: 'transient', reason: 'connection' });
    },
  );

  test('unique violation keeps the constraint name', () => {
    expect(classifyDbError(pgError('23505', { constraint: 'wallets_player_currency_key' }))).toEqual({
      kind: 'unique',
      constraint: 'wallets_player_currency_key',
    });
  });

  test('constraint name is found on a wrapped cause', () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      sqlState: '23505',
      cause: pgError('23505', { constraint: 'wager_tx_provider_external_key' }),
    });
    expect(classifyDbError(wrapped)).toEqual({ kind: 'unique', constraint: 'wager_tx_provider_external_key' });
  });

  test.each(['23514', '23503', '22003', 'P0001'])('SQLSTATE %s is an integrity violation', (code) => {
    expect(classifyDbError(pgError(code)).kind).toBe('integrity');
  });

  test('anything else is unknown', () => {
    expect(classifyDbError(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifyDbError('not an error')).toEqual({ kind: 'unknown' });
  });
});
