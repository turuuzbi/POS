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
const HOUR = 60 * MINUTE;

export const THROTTLE_RULES = {
  /** One account from one source: the main guard against password guessing. */
  accountFromSource: { freeAttempts: 4, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /**
   * One account from a browser that has signed in to it before (signed
   * "known browser" cookie). Replaces the source and account buckets for that
   * browser, so nobody sharing the shop's network can lock it out.
   */
  knownBrowser: { freeAttempts: 4, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /**
   * One account from all sources: bounds distributed guessing. Never applies
   * to sources the account has signed in from before (TrustedSignInSource)
   * or to known browsers, so an attack can't lock the owner out of their
   * usual network; elsewhere the owner can still sign in by PIN on a paired
   * device, and `pnpm auth:unlock <email>` clears it.
   */
  account: { freeAttempts: 20, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /** One source (IPv4 address or IPv6 /64) across all accounts: password spraying. */
  source: { freeAttempts: 30, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /** One IPv6 /48 across all accounts: an attacker rotating through /64s. */
  sourceNetwork: { freeAttempts: 100, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /** PIN entry (sign-in and manager approvals) on one paired device. */
  device: { freeAttempts: 6, baseMs: MINUTE, maxMs: 15 * MINUTE, windowMs: HOUR },
  /** The same device over a day, so the hourly allowance can't add up to a PIN search. */
  deviceDaily: { freeAttempts: 30, baseMs: 15 * MINUTE, maxMs: 2 * HOUR, windowMs: 24 * HOUR },
} as const satisfies Record<string, ThrottleRule>;

/** Longest window of any rule: rows idle for longer than this carry no state. */
export const LONGEST_WINDOW_MS = Math.max(
  ...Object.values(THROTTLE_RULES).map((rule) => rule.windowMs),
);

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
