/**
 * Brute-force throttling policy (pure). Failures are counted in fixed
 * windows: the first few in a window are free; each further one locks for an
 * exponentially growing period, capped. A new window starts fresh, so an
 * occasional typo — or an attacker's slow drip — can't escalate forever.
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
  accountFromSource: { freeAttempts: 4, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
  /**
   * One account from all sources: bounds distributed guessing. Never applies
   * to sources the account has signed in from before (TrustedSignInSource),
   * so an attack can't lock the owner out of their usual network; elsewhere
   * the owner can still sign in by PIN on a paired device.
   */
  account: { freeAttempts: 20, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
  /** One source across all accounts: password spraying / enumeration. */
  source: { freeAttempts: 30, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: 60 * MINUTE },
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
