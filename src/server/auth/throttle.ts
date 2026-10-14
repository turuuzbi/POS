import "server-only";
import { isIP } from "node:net";
import type { PrismaClient } from "@/generated/prisma/client";
import { deriveKey, hmacSha256 } from "../crypto";
import type { Db } from "../db";
import { env } from "../env";
import { LONGEST_WINDOW_MS, lockUntilAfterFailure, type ThrottleRule } from "./lockout";

/** Source bucket for requests whose client address is missing or malformed. */
export const UNKNOWN_SOURCE = "unknown";

/**
 * Normalise a client address into a bounded throttle source. IPv4 as-is;
 * IPv6 grouped by /64 (one subscriber typically owns a whole /64, so per-
 * address buckets would be trivially rotated); anything that isn't an IP
 * literal (spoofed or oversized X-Forwarded-For) → "unknown".
 */
export function throttleSource(ip: string | null | undefined): string {
  const value = ip?.trim();
  if (!value || value.length > 64) return UNKNOWN_SOURCE;
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) {
    const groups = ipv6Groups(value);
    return typeof groups === "string" ? groups : `${groups.slice(0, 4).join(":")}::/64`;
  }
  return UNKNOWN_SOURCE;
}

/**
 * The IPv6 /48 a client address belongs to, or null for IPv4 and unknown
 * sources. An attacker with a routed /48 has 65,536 /64s to rotate through;
 * this coarser bucket bounds them together.
 */
export function throttleNetwork(ip: string | null | undefined): string | null {
  const value = ip?.trim();
  if (!value || value.length > 64 || isIP(value) !== 6) return null;
  const groups = ipv6Groups(value);
  return typeof groups === "string" ? null : `${groups.slice(0, 3).join(":")}::/48`;
}

/** The eight hextets of an IPv6 literal, or the IPv4 address it maps. */
function ipv6Groups(address: string): string[] | string {
  const plain = address.split("%")[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail] = plain.split("::");
  const toGroups = (part: string) =>
    part
      ? part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [group];
          const [a, b, c, d] = group.split(".").map(Number) as [number, number, number, number];
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        })
      : [];
  const front = toGroups(head);
  const back = tail === undefined ? [] : toGroups(tail);
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  return groups.map((g) => parseInt(g || "0", 16).toString(16));
}

/**
 * Keyed hash of a normalised email. Throttle buckets use it instead of the
 * user id so that unknown emails get exactly the same buckets, queries and
 * answers as real accounts — the throttle can't reveal which accounts exist.
 */
export function emailKey(email: string): string {
  return hmacSha256(deriveKey(env().AUTH_SECRET, "throttle-email"), email.trim().toLowerCase());
}

/** Throttle bucket keys (see the AuthThrottle model). */
export const throttleKeys = {
  source: (source: string) => `pw:src:${source}`,
  network: (network: string) => `pw:net:${network}`,
  account: (email: string) => `pw:acct:${email}`,
  accountFromSource: (email: string, source: string) => `pw:acct-src:${email}:${source}`,
  knownBrowser: (email: string, browserId: string) => `pw:acct-br:${email}:${browserId}`,
  device: (deviceId: string) => `pin:dev:${deviceId}`,
  deviceDaily: (deviceId: string) => `pin:dev-day:${deviceId}`,
  trusted: (email: string, source: string) => `${email}:${source}`,
};

/** Every bucket that throttles PIN entry on a device. */
export function deviceThrottleKeys(deviceId: string): string[] {
  return [throttleKeys.device(deviceId), throttleKeys.deviceDaily(deviceId)];
}

export interface ThrottleBucket {
  key: string;
  rule: ThrottleRule;
  /** Whether an active lock on this bucket refuses the attempt (it is counted either way). */
  enforce: boolean;
}

interface CountedBucket {
  /** Window the attempt was counted in; a refund only applies within it. */
  windowStart: Date;
  /** The lock this attempt set, and what it replaced, so a refund can undo exactly that. */
  setLock: { lockedUntil: Date; previous: Date | null } | null;
  failures: number;
}

export interface Reservation {
  allowed: boolean;
  /** Enforced buckets whose active lock refused the attempt. */
  refusedBy: Set<string>;
  /** Buckets this attempt was counted on. */
  counted: Map<string, CountedBucket>;
}

/**
 * Count one attempt on each bucket BEFORE the credential is checked, and
 * decide whether it may be checked at all.
 *
 * One transaction locks the bucket rows (in key order, so concurrent
 * reservations can't deadlock), applies the fixed-window rules and writes the
 * new counts and locks. A burst of parallel attempts is therefore serialised:
 * each sees the attempts before it, and at most `freeAttempts + 1` of them
 * are checked before the lock refuses the rest. Locks are only ever extended
 * here, never shortened.
 *
 * Refused attempts are counted on the refusing buckets only (extending their
 * lock) unless `countRefused` is false; a correct credential later refunds
 * its own attempt with `settleSuccess`.
 */
export async function reserveAttempt(
  client: PrismaClient,
  buckets: ThrottleBucket[],
  now: Date,
  options: { countRefused?: boolean } = {},
): Promise<Reservation> {
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const keys = [...byKey.keys()].sort();
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "AuthThrottle" ("key", "failures", "windowStart", "lastFailureAt")
      SELECT k, 0, ${now}, ${now} FROM unnest(${keys}::text[]) AS k ORDER BY k
      ON CONFLICT ("key") DO NOTHING`;
    await tx.$queryRaw`
      SELECT "key" FROM "AuthThrottle" WHERE "key" = ANY(${keys}::text[])
      ORDER BY "key" COLLATE "C" FOR UPDATE`;
    const rows = await tx.authThrottle.findMany({ where: { key: { in: keys } } });
    const state = new Map(
      rows.map((row) => {
        const rule = byKey.get(row.key)!.rule;
        const expired = row.windowStart.getTime() <= now.getTime() - rule.windowMs;
        const active = row.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
        return [
          row.key,
          {
            // A new window starts the count afresh — but never cuts short an active lock.
            failures: expired ? 0 : row.failures,
            windowStart: expired ? now : row.windowStart,
            active,
          },
        ];
      }),
    );

    const refusedBy = new Set(
      keys.filter((key) => byKey.get(key)!.enforce && state.get(key)?.active),
    );
    const allowed = refusedBy.size === 0;
    const toCount = allowed ? keys : options.countRefused === false ? [] : [...refusedBy];

    const counted = new Map<string, CountedBucket>();
    for (const key of toCount) {
      const current = state.get(key)!;
      const failures = current.failures + 1;
      const proposed = lockUntilAfterFailure(failures, now, byKey.get(key)!.rule);
      const setLock =
        proposed && (!current.active || proposed > current.active)
          ? { lockedUntil: proposed, previous: current.active }
          : null;
      await tx.authThrottle.update({
        where: { key },
        data: {
          failures,
          windowStart: current.windowStart,
          lockedUntil: setLock?.lockedUntil ?? current.active,
          lastFailureAt: now,
        },
      });
      counted.set(key, { windowStart: current.windowStart, failures, setLock });
    }
    return { allowed, refusedBy, counted };
  });
}

/**
 * After a correct credential: take back this attempt's own count (and any
 * lock it set) on every bucket it was counted on, and delete `clear`
 * outright. Other attempts' counts are untouched, so a success can't wipe
 * out failures someone else caused.
 */
export async function settleSuccess(
  client: PrismaClient,
  reservation: Reservation,
  clear: string[] = [],
): Promise<void> {
  const refunds = [...reservation.counted].filter(([key]) => !clear.includes(key));
  const lockKeys = [...new Set([...refunds.map(([key]) => key), ...clear])].sort();
  if (lockKeys.length === 0) return;
  await client.$transaction(async (tx) => {
    // Same lock order as reserveAttempt (byte order), so the two can't deadlock.
    await tx.$queryRaw`
      SELECT "key" FROM "AuthThrottle" WHERE "key" = ANY(${lockKeys}::text[])
      ORDER BY "key" COLLATE "C" FOR UPDATE`;
    for (const [key, counted] of refunds) {
      await tx.authThrottle.updateMany({
        where: { key, windowStart: counted.windowStart, failures: { gt: 0 } },
        data: { failures: { decrement: 1 } },
      });
      if (counted.setLock) {
        await tx.authThrottle.updateMany({
          where: { key, lockedUntil: counted.setLock.lockedUntil },
          data: { lockedUntil: counted.setLock.previous },
        });
      }
    }
    if (clear.length > 0) await tx.authThrottle.deleteMany({ where: { key: { in: clear } } });
  });
}

export async function isTrustedSource(client: Db, key: string): Promise<boolean> {
  return (await client.trustedSignInSource.count({ where: { key } })) > 0;
}

export async function markTrustedSource(client: Db, key: string, now: Date): Promise<void> {
  await client.trustedSignInSource.upsert({
    where: { key },
    update: { lastSeenAt: now },
    create: { key, lastSeenAt: now },
  });
}

export async function clearThrottle(client: Db, keys: string[]): Promise<void> {
  if (keys.length > 0) await client.authThrottle.deleteMany({ where: { key: { in: keys } } });
}

/** Clear every password bucket of one account (recovery: `pnpm auth:unlock <email>`). */
export async function clearAccountThrottle(client: Db, email: string): Promise<number> {
  const account = emailKey(email);
  const { count } = await client.authThrottle.deleteMany({
    where: {
      OR: [
        { key: throttleKeys.account(account) },
        { key: { startsWith: `pw:acct-src:${account}:` } },
        { key: { startsWith: `pw:acct-br:${account}:` } },
      ],
    },
  });
  return count;
}

/** How long a trusted source stays trusted without a sign-in from it. */
export const TRUSTED_SOURCE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Delete sign-in state that can no longer matter: buckets idle for longer
 * than any window with no active lock, stale trusted sources and revoked
 * sessions past their expiry. Keeps the tables bounded however many
 * made-up emails or addresses an attacker throws at the sign-in form.
 */
export async function pruneAuthState(client: Db, now: Date): Promise<void> {
  await client.authThrottle.deleteMany({
    where: {
      lastFailureAt: { lt: new Date(now.getTime() - LONGEST_WINDOW_MS) },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
  });
  await client.trustedSignInSource.deleteMany({
    where: { lastSeenAt: { lt: new Date(now.getTime() - TRUSTED_SOURCE_TTL_MS) } },
  });
  await client.revokedSession.deleteMany({ where: { expiresAt: { lt: now } } });
}

/** Locked devices (either PIN bucket), for the devices screen. */
export async function lockedDeviceIds(client: Db, deviceIds: string[], now: Date) {
  if (deviceIds.length === 0) return new Set<string>();
  const rows = await client.authThrottle.findMany({
    where: { key: { in: deviceIds.flatMap(deviceThrottleKeys) }, lockedUntil: { gt: now } },
    select: { key: true },
  });
  return new Set(rows.map((row) => row.key.slice(row.key.indexOf(":", 4) + 1)));
}
