import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { THROTTLE_RULES } from "@/server/auth/lockout";
import {
  clearAccountThrottle,
  emailKey,
  pruneAuthState,
  reserveAttempt,
  settleSuccess,
  throttleKeys,
  TRUSTED_SOURCE_TTL_MS,
} from "@/server/auth/throttle";
import { db, resetDatabase } from "../support/db";

const rule = THROTTLE_RULES.accountFromSource;
const bucket = (key: string, enforce = true) => ({ key, rule, enforce });
const at = (iso: string) => new Date(iso);

describe("reserveAttempt / settleSuccess", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("counts before checking and refuses once the bucket is locked", async () => {
    const now = at("2026-05-01T09:00:00Z");
    const results = [];
    for (let i = 0; i < rule.freeAttempts + 2; i++) {
      results.push((await reserveAttempt(db, [bucket("k")], now)).allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("a success refunds its own attempt and undoes the lock it set — nothing more", async () => {
    const now = at("2026-05-01T09:00:00Z");
    for (let i = 0; i < rule.freeAttempts; i++) await reserveAttempt(db, [bucket("k")], now);
    const reservation = await reserveAttempt(db, [bucket("k")], now);
    expect(reservation.counted.get("k")?.setLock).not.toBeNull();
    await settleSuccess(db, reservation);
    expect(await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } })).toMatchObject({
      failures: rule.freeAttempts,
      lockedUntil: null,
    });
  });

  it("a refund never touches a lock someone else extended in the meantime", async () => {
    const now = at("2026-05-01T09:00:00Z");
    for (let i = 0; i < rule.freeAttempts; i++) await reserveAttempt(db, [bucket("k")], now);
    const mine = await reserveAttempt(db, [bucket("k")], now); // sets a 1-minute lock
    // A concurrent attempt from a trusted source (not enforced) extends it.
    await reserveAttempt(db, [bucket("k", false)], now);
    const extended = await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } });
    await settleSuccess(db, mine);
    const after = await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } });
    expect(after.lockedUntil).toEqual(extended.lockedUntil);
    expect(after.failures).toBe(extended.failures - 1);
  });

  it("starts a new window afresh but never cuts an active lock short", async () => {
    const start = at("2026-05-01T09:00:00Z");
    // Escalate to the 15-minute cap late in the window.
    const late = new Date(start.getTime() + rule.windowMs - 60_000);
    await reserveAttempt(db, [bucket("k")], start);
    for (let i = 0; i < rule.freeAttempts + 8; i++) {
      await reserveAttempt(db, [bucket("k", false)], late);
    }
    const locked = await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } });
    expect(locked.lockedUntil!.getTime() - late.getTime()).toBe(rule.maxMs);
    // Two minutes later the window has rolled over, the lock hasn't.
    const next = new Date(late.getTime() + 2 * 60_000);
    expect((await reserveAttempt(db, [bucket("k")], next)).allowed).toBe(false);
    const row = await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } });
    expect(row.failures).toBe(1);
    expect(row.lockedUntil).toEqual(locked.lockedUntil);
  });

  it("parallel attempts can never shorten a lock", async () => {
    const now = at("2026-05-01T09:00:00Z");
    await Promise.all(
      Array.from({ length: 30 }, () => reserveAttempt(db, [bucket("k", false)], now)),
    );
    const row = await db.authThrottle.findUniqueOrThrow({ where: { key: "k" } });
    expect(row.failures).toBe(30);
    expect(row.lockedUntil!.getTime() - now.getTime()).toBe(rule.maxMs);
  });
});

describe("pruneAuthState", () => {
  beforeEach(resetDatabase);

  it("deletes idle buckets, stale trusted sources and expired revocations — not active locks", async () => {
    const now = at("2026-05-10T09:00:00Z");
    const longAgo = at("2026-05-01T09:00:00Z");
    await db.authThrottle.createMany({
      data: [
        { key: "idle", failures: 3, windowStart: longAgo, lastFailureAt: longAgo },
        {
          key: "idle-but-locked",
          failures: 9,
          windowStart: longAgo,
          lastFailureAt: longAgo,
          lockedUntil: new Date(now.getTime() + 60_000),
        },
        { key: "recent", failures: 1, windowStart: now, lastFailureAt: now },
      ],
    });
    await db.trustedSignInSource.createMany({
      data: [
        { key: "old", lastSeenAt: new Date(now.getTime() - TRUSTED_SOURCE_TTL_MS - 1) },
        { key: "fresh", lastSeenAt: longAgo },
      ],
    });
    await db.revokedSession.createMany({
      data: [
        { sid: "0190a000-0000-7000-8000-000000000001", expiresAt: longAgo },
        { sid: "0190a000-0000-7000-8000-000000000002", expiresAt: new Date(now.getTime() + 1) },
      ],
    });
    await pruneAuthState(db, now);
    expect((await db.authThrottle.findMany()).map((r) => r.key).sort()).toEqual([
      "idle-but-locked",
      "recent",
    ]);
    expect((await db.trustedSignInSource.findMany()).map((r) => r.key)).toEqual(["fresh"]);
    expect(await db.revokedSession.count()).toBe(1);
  });
});

describe("clearAccountThrottle", () => {
  beforeEach(resetDatabase);

  it("clears every password bucket of one account and nothing else", async () => {
    const now = new Date();
    const mine = emailKey("o@shop.mn");
    const other = emailKey("m@shop.mn");
    const keys = [
      throttleKeys.account(mine),
      throttleKeys.accountFromSource(mine, "203.0.113.1"),
      throttleKeys.knownBrowser(mine, "A".repeat(22)),
      throttleKeys.account(other),
      throttleKeys.source("203.0.113.1"),
    ];
    await db.authThrottle.createMany({
      data: keys.map((key) => ({ key, failures: 30, windowStart: now, lastFailureAt: now })),
    });
    expect(await clearAccountThrottle(db, " O@shop.mn ")).toBe(3);
    expect((await db.authThrottle.findMany()).map((r) => r.key).sort()).toEqual(
      [throttleKeys.account(other), throttleKeys.source("203.0.113.1")].sort(),
    );
  });
});
