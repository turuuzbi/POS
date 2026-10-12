import { describe, expect, it } from "vitest";
import { isLocked, lockUntilAfterFailure, THROTTLE_RULES } from "./lockout";

const now = new Date("2026-01-01T00:00:00Z");
const minutes = (date: Date | null) => (date ? (date.getTime() - now.getTime()) / 60_000 : null);
const rule = THROTTLE_RULES.accountFromIp;

describe("lockUntilAfterFailure", () => {
  it("allows the free attempts without locking", () => {
    for (let failures = 1; failures <= rule.freeAttempts; failures++) {
      expect(lockUntilAfterFailure(failures, now, rule)).toBeNull();
    }
  });

  it("doubles the lock window per further failure, capped at 15 minutes", () => {
    expect(minutes(lockUntilAfterFailure(5, now, rule))).toBe(1);
    expect(minutes(lockUntilAfterFailure(6, now, rule))).toBe(2);
    expect(minutes(lockUntilAfterFailure(7, now, rule))).toBe(4);
    expect(minutes(lockUntilAfterFailure(8, now, rule))).toBe(8);
    expect(minutes(lockUntilAfterFailure(9, now, rule))).toBe(15);
    expect(minutes(lockUntilAfterFailure(50, now, rule))).toBe(15);
  });

  it("gives the all-sources account bucket far more headroom than a single source", () => {
    expect(THROTTLE_RULES.account.freeAttempts).toBeGreaterThan(rule.freeAttempts * 4);
    expect(lockUntilAfterFailure(20, now, THROTTLE_RULES.account)).toBeNull();
  });
});

describe("isLocked", () => {
  it("is locked only strictly before the expiry", () => {
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date(now.getTime() + 1), now)).toBe(true);
    expect(isLocked(now, now)).toBe(false);
  });
});
