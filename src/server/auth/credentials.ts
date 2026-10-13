import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { hasPermission, type Permission, type Role } from "@/domain/permissions";
import { audit } from "../audit";
import { findActiveDevice, type ActiveDevice } from "./device";
import { knownBrowserFor, rememberBrowser } from "./known-browser";
import { THROTTLE_RULES } from "./lockout";
import { burnPasswordCheck, verifyPassword } from "./password";
import { pinLookup, pinSchema } from "./pin";
import {
  emailKey,
  isTrustedSource,
  markTrustedSource,
  pruneAuthState,
  reserveAttempt,
  settleSuccess,
  throttleKeys,
  throttleNetwork,
  throttleSource,
  type ThrottleBucket,
} from "./throttle";

/**
 * Credential verification, independent of Auth.js so it can be tested
 * against a real database.
 *
 * Every attempt is counted before the credential is checked (see
 * reserveAttempt), so parallel requests can't slip extra guesses past the
 * throttle. Password failures are deliberately coarse: "wrong credentials"
 * and "account temporarily locked" look identical, so an attacker learns
 * nothing about which accounts exist; only a lock on the caller's own source
 * address is reported as RATE_LIMITED. A device PIN lock is reported as
 * LOCKED — it reveals nothing about any PIN.
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
  | {
      ok: true;
      user: AuthenticatedUser;
      /** New "known browser" cookie value to set (password sign-in only). */
      knownBrowser?: string;
    }
  | { ok: false; reason: SignInFailure };

interface Context {
  now?: Date;
  ip?: string | null;
  userAgent?: string | null;
  /** The request's known-browser cookie, if any. */
  knownBrowser?: string | null;
}

/** Fraction of failed attempts that also prune stale sign-in state. */
const PRUNE_PROBABILITY = 1 / 32;

async function maybePrune(client: PrismaClient, now: Date): Promise<void> {
  if (Math.random() < PRUNE_PROBABILITY) await pruneAuthState(client, now);
}

export async function verifyPasswordSignIn(
  client: PrismaClient,
  input: { email: string; password: string },
  ctx: Context = {},
): Promise<SignInResult> {
  const now = ctx.now ?? new Date();
  const source = throttleSource(ctx.ip);
  const network = throttleNetwork(ctx.ip);
  const email = input.email.trim().toLowerCase();
  const account = emailKey(email);
  const browserId = knownBrowserFor(ctx.knownBrowser, account);

  // Same queries whether or not the email exists: buckets are keyed by the
  // email itself, never by "is there such a user".
  const [user, trusted] = await Promise.all([
    client.user.findUnique({ where: { email } }),
    browserId
      ? Promise.resolve(true)
      : isTrustedSource(client, throttleKeys.trusted(account, source)),
  ]);

  const sourceKeys = [
    throttleKeys.source(source),
    ...(network ? [throttleKeys.network(network)] : []),
  ];
  const clearOnSuccess = browserId
    ? [throttleKeys.knownBrowser(account, browserId)]
    : [throttleKeys.accountFromSource(account, source)];
  const buckets: ThrottleBucket[] = browserId
    ? // A browser that has signed in to this account before has a bucket of
      // its own, out of reach of anyone else on the network.
      [{ key: clearOnSuccess[0]!, rule: THROTTLE_RULES.knownBrowser, enforce: true }]
    : [
        { key: sourceKeys[0]!, rule: THROTTLE_RULES.source, enforce: true },
        ...(network
          ? [{ key: sourceKeys[1]!, rule: THROTTLE_RULES.sourceNetwork, enforce: true }]
          : []),
        { key: clearOnSuccess[0]!, rule: THROTTLE_RULES.accountFromSource, enforce: true },
        // The account-wide lock stops distributed guessing, but never applies
        // to a source this account has signed in from before.
        { key: throttleKeys.account(account), rule: THROTTLE_RULES.account, enforce: !trusted },
      ];

  const reservation = await reserveAttempt(client, buckets, now);

  const fail = async (reason: "INVALID" | "RATE_LIMITED"): Promise<SignInResult> => {
    await audit(client, {
      actorId: null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user?.id ?? null,
      meta: { method: "password", throttled: !reservation.allowed || undefined },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await maybePrune(client, now);
    return { ok: false, reason };
  };

  if (!reservation.allowed) {
    // Same cost and same answer as a wrong password; never verify while locked.
    await burnPasswordCheck(input.password);
    const sourceLocked = sourceKeys.some((key) => reservation.refusedBy.has(key));
    return fail(sourceLocked ? "RATE_LIMITED" : "INVALID");
  }

  const canSignIn = user !== null && user.passwordHash !== null && user.isActive;
  const valid = canSignIn
    ? await verifyPassword(user.passwordHash!, input.password)
    : (await burnPasswordCheck(input.password), false);
  if (!valid || !user) return fail("INVALID");

  // The account+source (or known-browser) bucket is the user's own and is
  // cleared; shared buckets only get this attempt back, so a sign-in never
  // erases failures that others caused.
  await settleSuccess(client, reservation, clearOnSuccess);
  await markTrustedSource(client, throttleKeys.trusted(account, source), now);
  await client.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  await audit(client, {
    actorId: user.id,
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
    meta: { method: "password", knownBrowser: browserId !== null || undefined },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return {
    ok: true,
    knownBrowser: rememberBrowser(ctx.knownBrowser, account),
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
 * manager approvals, which share the same per-device throttle: there,
 * `requiredPermission` makes a PIN whose owner lacks the permission count
 * — and answer — exactly like a wrong PIN, so approvals can't be used to
 * discover other staff members' PINs.
 *
 * A correct PIN refunds only its own attempt; it never resets the device's
 * failures, which may have been someone else's guesses.
 */
export async function verifyDevicePin(
  client: PrismaClient,
  input: { pin: string; deviceToken: string | null; requiredPermission?: Permission },
  ctx: Context = {},
): Promise<
  | { ok: true; user: AuthenticatedUser & { locationIds: string[] }; device: ActiveDevice }
  | { ok: false; reason: "INVALID" | "DEVICE_REQUIRED" | "LOCKED" }
> {
  const now = ctx.now ?? new Date();
  const device = await findActiveDevice(client, input.deviceToken);
  if (!device) return { ok: false, reason: "DEVICE_REQUIRED" };

  // Attempts made while locked don't extend the lock: a cashier retrying
  // shouldn't make the wait longer.
  const reservation = await reserveAttempt(
    client,
    [
      { key: throttleKeys.device(device.id), rule: THROTTLE_RULES.device, enforce: true },
      { key: throttleKeys.deviceDaily(device.id), rule: THROTTLE_RULES.deviceDaily, enforce: true },
    ],
    now,
    { countRefused: false },
  );
  if (!reservation.allowed) return { ok: false, reason: "LOCKED" };

  const user = pinSchema.safeParse(input.pin).success
    ? await client.user.findUnique({
        where: { pinLookup: pinLookup(input.pin) },
        include: { locations: { select: { locationId: true } } },
      })
    : null;
  const locationIds = user?.locations.map((l) => l.locationId) ?? [];
  const allowedHere = user?.role === "OWNER" || locationIds.includes(device.locationId);
  const permitted =
    !input.requiredPermission ||
    (user !== null && hasPermission(user.role, input.requiredPermission));

  if (!user || !user.isActive || !allowedHere || !permitted) {
    const hourly = reservation.counted.get(throttleKeys.device(device.id));
    await audit(client, {
      actorId: null,
      action: "auth.pin_failed",
      entityType: "Device",
      entityId: device.id,
      locationId: device.locationId,
      registerId: device.registerId,
      meta: {
        failures: hourly?.failures ?? null,
        locked: [...reservation.counted.values()].some((c) => c.setLock !== null),
        purpose: input.requiredPermission ? "approval" : "sign_in",
        permission: input.requiredPermission,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await maybePrune(client, now);
    return { ok: false, reason: "INVALID" };
  }

  await settleSuccess(client, reservation);
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
  client: PrismaClient,
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
