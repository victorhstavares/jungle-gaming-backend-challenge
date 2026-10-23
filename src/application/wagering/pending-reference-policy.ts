/**
 * Ten attempts with 1s·2ⁿ backoff capped at five minutes give a reference about 13.5 minutes to arrive.
 * Providers normally send the referenced operation within seconds; anything later is treated as missing.
 */
export const PENDING_REFERENCE_MAX_ATTEMPTS = 10;
export const PENDING_REFERENCE_BASE_BACKOFF_MS = 1_000;
export const PENDING_REFERENCE_MAX_BACKOFF_MS = 300_000;

export function nextPendingAttemptAt(now: Date, attemptsSoFar: number): Date {
  const delay = Math.min(PENDING_REFERENCE_BASE_BACKOFF_MS * 2 ** attemptsSoFar, PENDING_REFERENCE_MAX_BACKOFF_MS);
  return new Date(now.getTime() + delay);
}
