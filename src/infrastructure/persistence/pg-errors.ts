export type TransientReason = 'lock_timeout' | 'conflict' | 'connection';

export type DbErrorClass =
  | { kind: 'transient'; reason: TransientReason }
  | { kind: 'unique'; constraint: string }
  | { kind: 'integrity'; detail: string }
  | { kind: 'unknown' };

const LOCK_STATES = new Set(['55P03', '57014']);
const CONFLICT_STATES = new Set(['40001', '40P01']);
const CONNECTION_STATES = new Set(['57P01', '57P02', '57P03', '53300']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
const INTEGRITY_STATES = new Set(['23514', '23503', '23502', '22003', 'P0001']);
// node-postgres and pg-pool raise these without a SQLSTATE when the socket drops or the pool cannot connect.
const CODELESS_CONNECTION_ERRORS = /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Connection ended unexpectedly/i;

interface ErrorFacts {
  code?: string;
  constraint?: string;
  message: string;
}

function factsOf(error: unknown): ErrorFacts[] {
  const facts: ErrorFacts[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(current, 'code') ?? Reflect.get(current, 'sqlState');
    const constraint: unknown = Reflect.get(current, 'constraint');
    facts.push({
      message: current.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof constraint === 'string' ? { constraint } : {}),
    });
    current = current.cause;
  }
  return facts;
}

/** Maps a driver error to how the caller should react: retry, report a conflict, or treat it as permanent. */
export function classifyDbError(error: unknown): DbErrorClass {
  const facts = factsOf(error);
  for (const fact of facts) {
    const code = fact.code;
    if (code === undefined) continue;
    if (LOCK_STATES.has(code)) return { kind: 'transient', reason: 'lock_timeout' };
    if (CONFLICT_STATES.has(code)) return { kind: 'transient', reason: 'conflict' };
    if (code.startsWith('08') || CONNECTION_STATES.has(code) || TRANSIENT_NODE_CODES.has(code)) {
      return { kind: 'transient', reason: 'connection' };
    }
    if (code === '23505') {
      const constraint = facts.find((f) => f.constraint !== undefined)?.constraint ?? 'unknown';
      return { kind: 'unique', constraint };
    }
    if (INTEGRITY_STATES.has(code)) {
      return { kind: 'integrity', detail: fact.message };
    }
  }
  if (facts.some((fact) => fact.code === undefined && CODELESS_CONNECTION_ERRORS.test(fact.message))) {
    return { kind: 'transient', reason: 'connection' };
  }
  return { kind: 'unknown' };
}
