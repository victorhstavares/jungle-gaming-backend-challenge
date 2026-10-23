import { describe, expect, test } from 'bun:test';
import { ContractError } from '../../../src/application/errors';
import { parseWagerCommand } from '../../../src/application/wagering/wager-command';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-kind';

const supported = new Set(['BRL']);

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...overrides,
});

const parse = (raw: unknown, key: string | undefined = 'provider-a:transaction-123') =>
  parseWagerCommand(raw, key, supported);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ContractError ? error.code : 'NOT_A_CONTRACT_ERROR';
  }
};

describe('parseWagerCommand', () => {
  test('parses the README example', () => {
    const cmd = parse(body());
    expect(cmd.kind).toBe(WagerTransactionKind.Bet);
    expect(cmd.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(cmd.idempotencyKey).toBe('provider-a:transaction-123');
    expect(cmd.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('OPENING is internal', () => {
    expect(codeOf(() => parse(body({ kind: 'OPENING' })))).toBe('OPENING_NOT_ALLOWED');
  });

  test('zero is only valid for LOSS', () => {
    expect(codeOf(() => parse(body({ money: { amount: '0.00', currency: 'BRL' } })))).toBe('INVALID_MONEY');
    expect(parse(body({ kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })).money.isZero()).toBe(true);
  });

  test('malformed money and unsupported currency have their own codes', () => {
    expect(codeOf(() => parse(body({ money: { amount: '25.5', currency: 'BRL' } })))).toBe('INVALID_MONEY');
    expect(codeOf(() => parse(body({ money: { amount: 25, currency: 'BRL' } })))).toBe('INVALID_MONEY');
    expect(codeOf(() => parse(body({ money: { amount: '1.00', currency: 'USD' } })))).toBe('UNSUPPORTED_CURRENCY');
  });

  test('identifiers are bounded and well formed', () => {
    expect(codeOf(() => parse(body({ roundId: 'r'.repeat(129) })))).toBe('INVALID_PAYLOAD');
    expect(codeOf(() => parse(body({ roundId: 'r'.repeat(10_000) })))).toBe('INVALID_PAYLOAD');
    expect(codeOf(() => parse(body({ providerId: 'provider a' })))).toBe('INVALID_PAYLOAD');
    expect(codeOf(() => parse(body({ walletId: 'not-a-uuid' })))).toBe('INVALID_PAYLOAD');
    expect(codeOf(() => parse(body({ kind: 'JACKPOT' })))).toBe('INVALID_PAYLOAD');
    expect(codeOf(() => parse('not an object'))).toBe('INVALID_PAYLOAD');
  });

  test('unknown fields are refused instead of silently ignored', () => {
    expect(codeOf(() => parse(body({ bonus: '10.00' })))).toBe('INVALID_PAYLOAD');
  });

  test('reversals need a reference', () => {
    expect(codeOf(() => parse(body({ kind: 'REFUND' })))).toBe('INVALID_PAYLOAD');
    expect(parse(body({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' })).referenceExternalTransactionId).toBe(
      'bet-1',
    );
  });

  test('the idempotency key is mandatory and bounded', () => {
    expect(codeOf(() => parseWagerCommand(body(), undefined, supported))).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(codeOf(() => parse(body(), ''))).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(codeOf(() => parse(body(), 'k'.repeat(257)))).toBe('INVALID_PAYLOAD');
  });

  test('payload hash ignores key order and the idempotency key', () => {
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    expect(parse(reordered).payloadHash).toBe(parse(body()).payloadHash);
    expect(parse(body(), 'another-key').payloadHash).toBe(parse(body()).payloadHash);
  });

  test('payload hash changes with any business field', () => {
    expect(parse(body({ gameId: 'other-game' })).payloadHash).not.toBe(parse(body()).payloadHash);
    expect(parse(body({ money: { amount: '25.01', currency: 'BRL' } })).payloadHash).not.toBe(parse(body()).payloadHash);
  });

  test('issues point at the offending field', () => {
    try {
      parse(body({ roundId: '' }));
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).issues.map((i) => i.path)).toContain('roundId');
    }
  });
});
