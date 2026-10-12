import "server-only";
import { isIP } from "node:net";
import { deriveKey, hmacSha256 } from "../crypto";
import type { Db } from "../db";
import { env } from "../env";
import { lockUntilAfterFailure, type ThrottleRule } from "./lockout";

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
  if (version === 6) return ipv6Prefix64(value);
  return UNKNOWN_SOURCE;
}

function ipv6Prefix64(address: string): string {
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
      : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g: string) => parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
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
  account: (email: string) => `pw:acct:${email}`,
  accountFromSource: (email: string, source: string) => `pw:acct-src:${email}:${source}`,
  device: (deviceId: string) => `pin:dev:${deviceId}`,
  trusted: (email: string, source: string) => `${email}:${source}`,
};

export interface ThrottleState {
  locked: Set<string>;
  trusted: boolean;
}

/** Which of these buckets are locked, and is this a trusted source — in one round trip. */
export async function throttleState(
  client: Db,
  keys: string[],
  trustedKey: string | null,
  now: Date,
): Promise<ThrottleState> {
  const rows = await client.$queryRaw<{ key: string; locked: boolean; trusted: boolean }[]>`
    SELECT "key", COALESCE("lockedUntil" > ${now}, false) AS "locked", false AS "trusted"
      FROM "AuthThrottle" WHERE "key" = ANY(${keys}::text[])
    UNION ALL
    SELECT "key", false AS "locked", true AS "trusted"
      FROM "TrustedSignInSource" WHERE "key" = ${trustedKey ?? ""}`;
  return {
    locked: new Set(rows.filter((r) => r.locked).map((r) => r.key)),
    trusted: rows.some((r) => r.trusted),
  };
}

export async function isThrottled(client: Db, keys: string[], now: Date): Promise<boolean> {
  return (await throttleState(client, keys, null, now)).locked.size > 0;
}

/**
 * Count one failure on each bucket atomically (one statement, so a failure
 * can't be recorded on some buckets and not others) and lock the buckets
 * that exceed their rule. Failures are counted in fixed windows: a new
 * window starts once the previous one is over, so a slow drip can't keep
 * escalating — and an active lock is never cut short.
 */
export async function recordFailures(
  client: Db,
  entries: { key: string; rule: ThrottleRule }[],
  now: Date,
): Promise<Map<string, { failures: number; lockedUntil: Date | null }>> {
  const result = new Map<string, { failures: number; lockedUntil: Date | null }>();
  const byWindow = new Map<number, typeof entries>();
  for (const entry of entries) {
    byWindow.set(entry.rule.windowMs, [...(byWindow.get(entry.rule.windowMs) ?? []), entry]);
  }
  for (const [windowMs, group] of byWindow) {
    const cutoff = new Date(now.getTime() - windowMs);
    const keys = group.map((entry) => entry.key);
    const rows = await client.$queryRaw<
      { key: string; failures: number; lockedUntil: Date | null }[]
    >`
      INSERT INTO "AuthThrottle" ("key", "failures", "windowStart", "lastFailureAt")
      SELECT k, 1, ${now}, ${now} FROM unnest(${keys}::text[]) AS k
      ON CONFLICT ("key") DO UPDATE SET
        "failures" = CASE WHEN "AuthThrottle"."windowStart" < ${cutoff}
                          THEN 1 ELSE "AuthThrottle"."failures" + 1 END,
        "lockedUntil" = CASE
          WHEN "AuthThrottle"."windowStart" < ${cutoff}
               AND ("AuthThrottle"."lockedUntil" IS NULL OR "AuthThrottle"."lockedUntil" <= ${now})
          THEN NULL ELSE "AuthThrottle"."lockedUntil" END,
        "windowStart" = CASE WHEN "AuthThrottle"."windowStart" < ${cutoff}
                             THEN ${now} ELSE "AuthThrottle"."windowStart" END,
        "lastFailureAt" = ${now}
      RETURNING "key", "failures", "lockedUntil"`;
    for (const row of rows) {
      const rule = group.find((entry) => entry.key === row.key)!.rule;
      const failures = Number(row.failures);
      const proposed = lockUntilAfterFailure(failures, now, rule);
      const existing = row.lockedUntil ? new Date(row.lockedUntil) : null;
      // Never shorten an active lock.
      const lockedUntil =
        proposed && (!existing || proposed > existing) ? proposed : (existing ?? null);
      if (proposed && lockedUntil === proposed) {
        await client.authThrottle.update({ where: { key: row.key }, data: { lockedUntil } });
      }
      result.set(row.key, { failures, lockedUntil });
    }
  }
  return result;
}

export async function clearThrottle(client: Db, keys: string[]): Promise<void> {
  if (keys.length > 0) await client.authThrottle.deleteMany({ where: { key: { in: keys } } });
}

export async function markTrustedSource(client: Db, key: string, now: Date): Promise<void> {
  await client.trustedSignInSource.upsert({
    where: { key },
    update: { lastSeenAt: now },
    create: { key, lastSeenAt: now },
  });
}

/** Locked device buckets, for the devices screen. */
export async function lockedDeviceIds(client: Db, deviceIds: string[], now: Date) {
  if (deviceIds.length === 0) return new Set<string>();
  const rows = await client.authThrottle.findMany({
    where: { key: { in: deviceIds.map(throttleKeys.device) }, lockedUntil: { gt: now } },
    select: { key: true },
  });
  return new Set(rows.map((row) => row.key.slice("pin:dev:".length)));
}
