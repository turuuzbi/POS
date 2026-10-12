import "server-only";
import type { Role } from "@/domain/permissions";
import { audit } from "../audit";
import type { Db } from "../db";
import { findActiveDevice, type ActiveDevice } from "./device";
import { THROTTLE_RULES } from "./lockout";
import { burnPasswordCheck, verifyPassword } from "./password";
import { pinLookup, pinSchema } from "./pin";
import { clearThrottle, isThrottled, recordFailure, throttleKeys, UNKNOWN_IP } from "./throttle";

/**
 * Credential verification, independent of Auth.js so it can be tested
 * against a real database.
 *
 * Password failures are deliberately coarse: "wrong credentials" and
 * "account temporarily locked" look identical, so an attacker learns
 * nothing about which accounts exist; only a lock on the caller's own
 * source address is reported as RATE_LIMITED. A device PIN lock is reported
 * as LOCKED — it reveals nothing about any PIN.
 */

export interface AuthenticatedUser {
  id: string;
  name: string;
  role: Role;
  locale: string | null;
  tokenVersion: number;
  deviceId: string | null;
}

export type SignInFailure = "INVALID" | "DEVICE_REQUIRED" | "LOCKED" | "RATE_LIMITED";

export type SignInResult =
  { ok: true; user: AuthenticatedUser } | { ok: false; reason: SignInFailure };

interface Context {
  now?: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export async function verifyPasswordSignIn(
  client: Db,
  input: { email: string; password: string },
  ctx: Context = {},
): Promise<SignInResult> {
  const now = ctx.now ?? new Date();
  const ip = ctx.ip?.trim() || UNKNOWN_IP;
  const email = input.email.trim().toLowerCase();
  const user = await client.user.findUnique({ where: { email } });

  const ipKey = throttleKeys.ip(ip);
  const accountKeys = user
    ? [throttleKeys.account(user.id), throttleKeys.accountFromIp(user.id, ip)]
    : [];

  if (await isThrottled(client, [ipKey], now)) {
    await burnPasswordCheck(input.password);
    return { ok: false, reason: "RATE_LIMITED" };
  }
  if (await isThrottled(client, accountKeys, now)) {
    // Same cost and same answer as a wrong password; don't verify while locked.
    await burnPasswordCheck(input.password);
    return { ok: false, reason: "INVALID" };
  }

  const canSignIn = user !== null && user.passwordHash !== null && user.isActive;
  const valid = canSignIn
    ? await verifyPassword(user.passwordHash!, input.password)
    : (await burnPasswordCheck(input.password), false);

  if (!valid || !user) {
    await recordFailure(client, ipKey, THROTTLE_RULES.ip, now);
    if (user) {
      await recordFailure(client, throttleKeys.account(user.id), THROTTLE_RULES.account, now);
      await recordFailure(
        client,
        throttleKeys.accountFromIp(user.id, ip),
        THROTTLE_RULES.accountFromIp,
        now,
      );
    }
    // Audited for unknown emails too (no PII), which also evens out timing.
    await audit(client, {
      actorId: null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user?.id ?? null,
      meta: { method: "password" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: "INVALID" };
  }

  await clearThrottle(client, accountKeys);
  await client.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  await audit(client, {
    actorId: user.id,
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
    meta: { method: "password" },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      locale: user.locale,
      tokenVersion: user.tokenVersion,
      deviceId: null,
    },
  };
}

/**
 * Resolve the staff member behind a PIN on a paired device. Also used for
 * manager approvals, which share the same per-device throttle.
 */
export async function verifyDevicePin(
  client: Db,
  input: { pin: string; deviceToken: string | null },
  ctx: Context = {},
): Promise<
  | { ok: true; user: AuthenticatedUser & { locationIds: string[] }; device: ActiveDevice }
  | { ok: false; reason: "INVALID" | "DEVICE_REQUIRED" | "LOCKED" }
> {
  const now = ctx.now ?? new Date();
  const device = await findActiveDevice(client, input.deviceToken);
  if (!device) return { ok: false, reason: "DEVICE_REQUIRED" };
  const deviceKey = throttleKeys.device(device.id);
  if (await isThrottled(client, [deviceKey], now)) return { ok: false, reason: "LOCKED" };

  const user = pinSchema.safeParse(input.pin).success
    ? await client.user.findUnique({
        where: { pinLookup: pinLookup(input.pin) },
        include: { locations: { select: { locationId: true } } },
      })
    : null;
  const locationIds = user?.locations.map((l) => l.locationId) ?? [];
  const allowedHere = user?.role === "OWNER" || locationIds.includes(device.locationId);

  if (!user || !user.isActive || !allowedHere) {
    const { failures, lockedUntil } = await recordFailure(
      client,
      deviceKey,
      THROTTLE_RULES.device,
      now,
    );
    await audit(client, {
      actorId: null,
      action: "auth.pin_failed",
      entityType: "Device",
      entityId: device.id,
      locationId: device.locationId,
      registerId: device.registerId,
      meta: { failures, locked: lockedUntil !== null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: "INVALID" };
  }

  await clearThrottle(client, [deviceKey]);
  return {
    ok: true,
    device,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      locale: user.locale,
      tokenVersion: user.tokenVersion,
      deviceId: device.id,
      locationIds,
    },
  };
}

export async function verifyPinSignIn(
  client: Db,
  input: { pin: string; deviceToken: string | null },
  ctx: Context = {},
): Promise<SignInResult> {
  const result = await verifyDevicePin(client, input, ctx);
  if (!result.ok) return result;
  const now = ctx.now ?? new Date();
  await client.user.update({ where: { id: result.user.id }, data: { lastLoginAt: now } });
  await client.device.update({ where: { id: result.device.id }, data: { lastSeenAt: now } });
  await audit(client, {
    actorId: result.user.id,
    action: "auth.login",
    entityType: "User",
    entityId: result.user.id,
    locationId: result.device.locationId,
    registerId: result.device.registerId,
    meta: { method: "pin", deviceId: result.device.id },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  const { locationIds: _locationIds, ...user } = result.user;
  return { ok: true, user };
}
