/**
 * Brute-force throttling policy (pure): the first few failures are free, then
 * each further failure locks for an exponentially growing window, capped.
 * 5 failures → 1 min, 6 → 2 min, 7 → 4 min, … max 15 min.
 */
export const LOCKOUT_POLICY = {
  freeAttempts: 4,
  baseMs: 60_000,
  maxMs: 15 * 60_000,
} as const;

/** Lock expiry after the `failures`-th consecutive failure, or null if not locked. */
export function lockUntilAfterFailure(failures: number, now: Date): Date | null {
  const over = failures - LOCKOUT_POLICY.freeAttempts;
  if (over <= 0) return null;
  const ms = Math.min(LOCKOUT_POLICY.baseMs * 2 ** (over - 1), LOCKOUT_POLICY.maxMs);
  return new Date(now.getTime() + ms);
}

export function isLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}
