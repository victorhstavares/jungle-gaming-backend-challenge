import { z } from 'zod';
import { Money } from '../../domain/money/money';
import { canonicalJson, sha256Hex } from '../../domain/shared/canonical-json';
import { WagerTransactionKind } from '../../domain/wagering/wager-kind';
import { ContractError, isDomainError } from '../errors';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,256}$/;

const identifier = z.string().regex(IDENTIFIER, 'must match [A-Za-z0-9._:-]{1,128}');

const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const wagerSchema = z.strictObject({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(SUBMITTABLE_KINDS),
  money: z.strictObject({ amount: z.unknown(), currency: z.unknown() }),
  referenceExternalTransactionId: identifier.optional(),
});

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: (typeof SUBMITTABLE_KINDS)[number];
  money: Money;
  referenceExternalTransactionId?: string;
  /** SHA-256 hex of the canonical JSON of the business fields; transport metadata never enters it. */
  payloadHash: string;
}

/** Validates an untrusted request body or message payload into a command. Throws ContractError only. */
export function parseWagerCommand(
  raw: unknown,
  idempotencyKey: string | undefined,
  supportedCurrencies: ReadonlySet<string>,
): WagerCommand {
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    throw new ContractError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key is required');
  }
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new ContractError('INVALID_PAYLOAD', 'Idempotency-Key must be 1-256 printable ASCII characters', [
      { path: 'idempotencyKey', message: 'invalid format' },
    ]);
  }
  if (typeof raw === 'object' && raw !== null && Reflect.get(raw, 'kind') === WagerTransactionKind.Opening) {
    throw new ContractError('OPENING_NOT_ALLOWED', 'OPENING is internal and cannot be submitted', [
      { path: 'kind', message: 'OPENING is internal' },
    ]);
  }

  const parsed = wagerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError(
      'INVALID_PAYLOAD',
      'Invalid wager transaction payload',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const body = parsed.data;

  let money: Money;
  try {
    money = Money.from(
      {
        amount: typeof body.money.amount === 'string' ? body.money.amount : '',
        currency: typeof body.money.currency === 'string' ? body.money.currency : '',
      },
      supportedCurrencies,
    );
  } catch (error) {
    if (isDomainError(error)) throw ContractError.fromDomain(error, 'money');
    throw error;
  }
  if (money.isZero() && body.kind !== WagerTransactionKind.Loss) {
    throw new ContractError('INVALID_MONEY', 'Only LOSS may carry a zero amount', [
      { path: 'money.amount', message: 'must be greater than zero' },
    ]);
  }
  const requiresReference = body.kind === WagerTransactionKind.Refund || body.kind === WagerTransactionKind.Rollback;
  if (requiresReference && body.referenceExternalTransactionId === undefined) {
    throw new ContractError('INVALID_PAYLOAD', `${body.kind} requires referenceExternalTransactionId`, [
      { path: 'referenceExternalTransactionId', message: 'required' },
    ]);
  }

  const businessFields = {
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    kind: body.kind,
    money: { amount: money.toJSON().amount, currency: money.currency },
    referenceExternalTransactionId: body.referenceExternalTransactionId,
  };

  return {
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    idempotencyKey,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    kind: body.kind,
    money,
    ...(body.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: body.referenceExternalTransactionId }),
    payloadHash: sha256Hex(canonicalJson(businessFields)),
  };
}
