import "server-only";
import type { Db } from "../db";
import { lockUntilAfterFailure, type ThrottleRule } from "./lockout";

/** Throttle bucket keys (see the AuthThrottle model). */
export const throttleKeys = {
  ip: (ip: string) => `pw:ip:${ip}`,
  account: (userId: string) => `pw:acct:${userId}`,
  accountFromIp: (userId: string, ip: string) => `pw:acct-ip:${userId}:${ip}`,
  device: (deviceId: string) => `pin:dev:${deviceId}`,
};

/** Bucket name for requests whose source address is unknown. */
export const UNKNOWN_IP = "unknown";

/** Is any of these buckets currently locked? */
export async function isThrottled(client: Db, keys: string[], now: Date): Promise<boolean> {
  if (keys.length === 0) return false;
  const locked = await client.authThrottle.count({
    where: { key: { in: keys }, lockedUntil: { gt: now } },
  });
  return locked > 0;
}

/**
 * Count one failure atomically (safe under concurrent attempts) and lock the
 * bucket when it exceeds the rule. Failures older than the window restart at 1.
 */
export async function recordFailure(
  client: Db,
  key: string,
  rule: ThrottleRule,
  now: Date,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const windowStart = new Date(now.getTime() - rule.windowMs);
  const rows = await client.$queryRaw<{ failures: number }[]>`
    INSERT INTO "AuthThrottle" ("key", "failures", "lastFailureAt")
    VALUES (${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "failures" = CASE WHEN "AuthThrottle"."lastFailureAt" < ${windowStart}
                        THEN 1 ELSE "AuthThrottle"."failures" + 1 END,
      "lockedUntil" = CASE WHEN "AuthThrottle"."lastFailureAt" < ${windowStart}
                           THEN NULL ELSE "AuthThrottle"."lockedUntil" END,
      "lastFailureAt" = ${now}
    RETURNING "failures"`;
  const failures = Number(rows[0]?.failures ?? 1);
  const lockedUntil = lockUntilAfterFailure(failures, now, rule);
  if (lockedUntil) {
    await client.authThrottle.update({ where: { key }, data: { lockedUntil } });
  }
  return { failures, lockedUntil };
}

export async function clearThrottle(client: Db, keys: string[]): Promise<void> {
  if (keys.length > 0) await client.authThrottle.deleteMany({ where: { key: { in: keys } } });
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
