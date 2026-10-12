/**
 * Brute-force throttling policy (pure). The first few failures in a window
 * are free; each further failure locks for an exponentially growing period,
 * capped. Failures older than the window are forgotten, so an occasional typo
 * — or an attacker's slow drip — never escalates into long lockouts.
 */
export interface ThrottleRule {
  freeAttempts: number;
  baseMs: number;
  maxMs: number;
  windowMs: number;
}

const MINUTE = 60_000;

export const THROTTLE_RULES = {
  /** One account from one source: the main guard against password guessing. */
  accountFromIp: { freeAttempts: 4, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
  /**
   * One account from all sources: bounds distributed guessing. Deliberately
   * generous so a remote attacker can't cheaply lock the owner out (who can
   * still sign in by PIN on a paired device).
   */
  account: { freeAttempts: 20, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
  /** One source across all accounts: password spraying / enumeration. */
  ip: { freeAttempts: 30, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
  /** PIN entry (sign-in and manager approvals) on one paired device. */
  device: { freeAttempts: 4, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
} as const satisfies Record<string, ThrottleRule>;

/** Lock expiry after the `failures`-th failure within the window, or null if not locked. */
export function lockUntilAfterFailure(
  failures: number,
  now: Date,
  rule: ThrottleRule,
): Date | null {
  const over = failures - rule.freeAttempts;
  if (over <= 0) return null;
  const ms = Math.min(rule.baseMs * 2 ** (over - 1), rule.maxMs);
  return new Date(now.getTime() + ms);
}

export function isLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}
