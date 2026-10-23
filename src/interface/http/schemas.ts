import { z } from 'zod';
import { ContractError } from '../../application/errors';
import { LEDGER_DEFAULT_LIMIT } from '../../application/wallets/wallet-queries';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

export const openWalletBody = z.strictObject({
  playerId: z.uuid(),
  initialBalance: z.strictObject({ amount: z.string().max(32), currency: z.string().max(8) }),
});

function fail(path: string, message: string): never {
  throw new ContractError('INVALID_PAYLOAD', `Invalid ${path}`, [{ path, message }]);
}

export function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError(
      'INVALID_PAYLOAD',
      'Invalid request body',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

export function uuidParam(value: string, name: string): string {
  return z.uuid().safeParse(value).success ? value : fail(name, 'must be a UUID');
}

export function identifierParam(value: string, name: string): string {
  return IDENTIFIER.test(value) ? value : fail(name, 'must match [A-Za-z0-9._:-]{1,128}');
}

export function limitQuery(value: unknown): number {
  if (value === undefined) return LEDGER_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[0-9]{1,4}$/.test(value)) fail('limit', 'must be an integer');
  return Number(value);
}

export function cursorQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : fail('cursor', 'must be a string');
}

export function singleHeader(value: string | string[] | undefined, name: string): string | undefined {
  if (Array.isArray(value)) fail(name, 'must be sent once');
  return value;
}
