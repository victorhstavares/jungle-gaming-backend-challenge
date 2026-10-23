export type SqlRow = Record<string, unknown>;

export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
  throw new TypeError(`Expected a bigint column, got ${typeof value}`);
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`Expected a text column, got ${typeof value}`);
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' || typeof value === 'bigint') return Number(value);
  throw new TypeError(`Expected a numeric column, got ${typeof value}`);
}

export function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  throw new TypeError(`Expected a timestamp column, got ${typeof value}`);
}

export function asOptionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : asDate(value);
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'string') return asRecord(JSON.parse(value));
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
  throw new TypeError('Expected a JSON object column');
}

/** Narrows a persisted string to a member of a string enum, failing loudly on unknown values. */
export function asEnum<V extends string>(enumObject: Record<string, V>, value: unknown): V {
  const member = Object.values(enumObject).find((candidate) => candidate === value);
  if (member === undefined) {
    throw new TypeError(`Unknown enum value: ${String(value)}`);
  }
  return member;
}
