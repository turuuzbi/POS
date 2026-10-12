import "server-only";
import type { Role } from "@/domain/permissions";
import { audit } from "../audit";
import type { Db } from "../db";
import { findActiveDevice, type ActiveDevice } from "./device";
import { isLocked, lockUntilAfterFailure } from "./lockout";
import { burnPasswordCheck, verifyPassword } from "./password";
import { pinLookup, pinSchema } from "./pin";

/**
 * Credential verification, independent of Auth.js so it can be tested
 * against a real database. Failure reasons are deliberately coarse: the UI
 * shows one message for "wrong credentials" and "temporarily locked", so an
 * attacker learns nothing about which accounts exist.
 */

export interface AuthenticatedUser {
  id: string;
  name: string;
  role: Role;
  tokenVersion: number;
  deviceId: string | null;
}

export type SignInResult =
  { ok: true; user: AuthenticatedUser } | { ok: false; reason: "INVALID" | "DEVICE_REQUIRED" };

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
  const email = input.email.trim().toLowerCase();
  const user = await client.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash || !user.isActive) {
    await burnPasswordCheck(input.password);
    return { ok: false, reason: "INVALID" };
  }
  if (isLocked(user.lockedUntil, now)) {
    // Don't even verify: a locked account can't be brute-forced in the window.
    return { ok: false, reason: "INVALID" };
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    const { failedLogins } = await client.user.update({
      where: { id: user.id },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    });
    const lockedUntil = lockUntilAfterFailure(failedLogins, now);
    if (lockedUntil) await client.user.update({ where: { id: user.id }, data: { lockedUntil } });
    await audit(client, {
      actorId: null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user.id,
      meta: { method: "password", failedLogins, locked: lockedUntil !== null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: "INVALID" };
  }

  await client.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
  });
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
      tokenVersion: user.tokenVersion,
      deviceId: null,
    },
  };
}

/** Record a failed PIN attempt against the device and lock it when over the limit. */
async function registerPinFailure(client: Db, device: ActiveDevice, now: Date, ctx: Context) {
  const { failedPinAttempts } = await client.device.update({
    where: { id: device.id },
    data: { failedPinAttempts: { increment: 1 } },
    select: { failedPinAttempts: true },
  });
  const pinLockedUntil = lockUntilAfterFailure(failedPinAttempts, now);
  if (pinLockedUntil)
    await client.device.update({ where: { id: device.id }, data: { pinLockedUntil } });
  await audit(client, {
    actorId: null,
    action: "auth.pin_failed",
    entityType: "Device",
    entityId: device.id,
    locationId: device.locationId,
    registerId: device.registerId,
    meta: { failedPinAttempts, locked: pinLockedUntil !== null },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Resolve the staff member behind a PIN on a paired device. Also used for
 * manager approvals, which share the same per-device lockout.
 */
export async function verifyDevicePin(
  client: Db,
  input: { pin: string; deviceToken: string | null },
  ctx: Context = {},
): Promise<
  | { ok: true; user: AuthenticatedUser & { locationIds: string[] }; device: ActiveDevice }
  | { ok: false; reason: "INVALID" | "DEVICE_REQUIRED" }
> {
  const now = ctx.now ?? new Date();
  const device = await findActiveDevice(client, input.deviceToken);
  if (!device) return { ok: false, reason: "DEVICE_REQUIRED" };
  if (isLocked(device.pinLockedUntil, now)) return { ok: false, reason: "INVALID" };

  const user = pinSchema.safeParse(input.pin).success
    ? await client.user.findUnique({
        where: { pinLookup: pinLookup(input.pin) },
        include: { locations: { select: { locationId: true } } },
      })
    : null;
  const locationIds = user?.locations.map((l) => l.locationId) ?? [];
  const allowedHere = user?.role === "OWNER" || locationIds.includes(device.locationId);

  if (!user || !user.isActive || !allowedHere) {
    await registerPinFailure(client, device, now, ctx);
    return { ok: false, reason: "INVALID" };
  }

  if (device.failedPinAttempts > 0 || device.pinLockedUntil) {
    await client.device.update({
      where: { id: device.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  }
  return {
    ok: true,
    device,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
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
