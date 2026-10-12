import "server-only";
import type { Role } from "@/domain/permissions";
import { audit } from "../audit";
import type { Db } from "../db";
import { findActiveDevice, type ActiveDevice } from "./device";
import { THROTTLE_RULES } from "./lockout";
import { burnPasswordCheck, verifyPassword } from "./password";
import { pinLookup, pinSchema } from "./pin";
import {
  clearThrottle,
  emailKey,
  isThrottled,
  markTrustedSource,
  recordFailures,
  throttleKeys,
  throttleSource,
  throttleState,
} from "./throttle";

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
  const source = throttleSource(ctx.ip);
  const email = input.email.trim().toLowerCase();
  const account = emailKey(email);
  const keys = {
    source: throttleKeys.source(source),
    account: throttleKeys.account(account),
    accountFromSource: throttleKeys.accountFromSource(account, source),
  };
  const failureBuckets = [
    { key: keys.source, rule: THROTTLE_RULES.source },
    { key: keys.account, rule: THROTTLE_RULES.account },
    { key: keys.accountFromSource, rule: THROTTLE_RULES.accountFromSource },
  ];

  // Same queries whether or not the email exists: buckets are keyed by the
  // email itself, never by "is there such a user".
  const [user, state] = await Promise.all([
    client.user.findUnique({ where: { email } }),
    throttleState(
      client,
      [keys.source, keys.account, keys.accountFromSource],
      throttleKeys.trusted(account, source),
      now,
    ),
  ]);

  const fail = async (
    reason: "INVALID" | "RATE_LIMITED",
    buckets = failureBuckets,
  ): Promise<SignInResult> => {
    await recordFailures(client, buckets, now);
    await audit(client, {
      actorId: null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user?.id ?? null,
      meta: { method: "password", throttled: reason === "RATE_LIMITED" || undefined },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason };
  };

  if (state.locked.has(keys.source)) {
    // A locked source only extends its own lock (no collateral on accounts).
    await burnPasswordCheck(input.password);
    return fail("RATE_LIMITED", [failureBuckets[0]!]);
  }
  // The account-wide lock stops distributed guessing, but never applies to
  // a source this account has signed in from before.
  const accountLocked =
    state.locked.has(keys.accountFromSource) || (state.locked.has(keys.account) && !state.trusted);
  if (accountLocked) {
    // Same cost and same answer as a wrong password; don't verify while locked.
    await burnPasswordCheck(input.password);
    return fail("INVALID");
  }

  const canSignIn = user !== null && user.passwordHash !== null && user.isActive;
  const valid = canSignIn
    ? await verifyPassword(user.passwordHash!, input.password)
    : (await burnPasswordCheck(input.password), false);
  if (!valid || !user) return fail("INVALID");

  await clearThrottle(client, [keys.account, keys.accountFromSource]);
  await markTrustedSource(client, throttleKeys.trusted(account, source), now);
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
    const recorded = await recordFailures(
      client,
      [{ key: deviceKey, rule: THROTTLE_RULES.device }],
      now,
    );
    const { failures, lockedUntil } = recorded.get(deviceKey) ?? { failures: 1, lockedUntil: null };
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
