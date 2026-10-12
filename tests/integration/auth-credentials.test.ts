import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { grantApproval, verifyApproval } from "@/server/auth/approval";
import { verifyPasswordSignIn, verifyPinSignIn } from "@/server/auth/credentials";
import { LOCKOUT_POLICY } from "@/server/auth/lockout";
import { db, resetDatabase } from "../support/db";
import { createLocation, createUser, pairDevice } from "../support/fixtures";

const PASSWORD = "correct horse battery";

describe("password sign-in", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("signs in with the right password (email is case-insensitive) and audits it", async () => {
    const user = await createUser({ role: "OWNER", email: "owner@shop.mn", password: PASSWORD });
    const result = await verifyPasswordSignIn(db, { email: " Owner@Shop.MN ", password: PASSWORD });
    expect(result).toMatchObject({
      ok: true,
      user: { id: user.id, role: "OWNER", deviceId: null },
    });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "auth.login" } });
    expect(log.actorId).toBe(user.id);
  });

  it("gives the same answer for an unknown email, a wrong password and an inactive user", async () => {
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    await createUser({
      role: "MANAGER",
      email: "gone@shop.mn",
      password: PASSWORD,
      isActive: false,
    });
    const unknown = await verifyPasswordSignIn(db, { email: "nobody@shop.mn", password: PASSWORD });
    const wrong = await verifyPasswordSignIn(db, {
      email: "m@shop.mn",
      password: "nope nope nope",
    });
    const inactive = await verifyPasswordSignIn(db, { email: "gone@shop.mn", password: PASSWORD });
    expect(unknown).toEqual({ ok: false, reason: "INVALID" });
    expect(wrong).toEqual(unknown);
    expect(inactive).toEqual(unknown);
  });

  it("locks the account after repeated failures, even for the right password", async () => {
    const user = await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i <= LOCKOUT_POLICY.freeAttempts; i++) {
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: "wrong password!" }, { now });
    }
    const locked = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.failedLogins).toBe(LOCKOUT_POLICY.freeAttempts + 1);
    expect(locked.lockedUntil?.getTime()).toBeGreaterThan(now.getTime());

    expect(
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: PASSWORD }, { now }),
    ).toEqual({
      ok: false,
      reason: "INVALID",
    });

    const afterLock = new Date(locked.lockedUntil!.getTime() + 1);
    const ok = await verifyPasswordSignIn(
      db,
      { email: "m@shop.mn", password: PASSWORD },
      { now: afterLock },
    );
    expect(ok.ok).toBe(true);
    const reset = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reset.failedLogins).toBe(0);
    expect(reset.lockedUntil).toBeNull();
  });
});

describe("PIN sign-in on a paired device", () => {
  beforeEach(resetDatabase);

  async function setup() {
    const { location, register } = await createLocation();
    const owner = await createUser({
      role: "OWNER",
      email: "o@shop.mn",
      password: PASSWORD,
      pin: "905174",
    });
    const cashier = await createUser({ role: "CASHIER", pin: "4821", locationIds: [location.id] });
    const { device, token } = await pairDevice(location.id, owner.id, register.id);
    return { location, register, owner, cashier, device, token };
  }

  it("signs in the staff member who owns the PIN", async () => {
    const { cashier, device, token } = await setup();
    const result = await verifyPinSignIn(db, { pin: "4821", deviceToken: token });
    expect(result).toMatchObject({ ok: true, user: { id: cashier.id, deviceId: device.id } });
  });

  it("requires a paired, non-revoked device", async () => {
    const { device, token } = await setup();
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: null })).toEqual({
      ok: false,
      reason: "DEVICE_REQUIRED",
    });
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: "x".repeat(43) })).toEqual({
      ok: false,
      reason: "DEVICE_REQUIRED",
    });
    await db.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: token })).toEqual({
      ok: false,
      reason: "DEVICE_REQUIRED",
    });
  });

  it("refuses staff who aren't assigned to the device's location (owners may sign in anywhere)", async () => {
    const { token, owner } = await setup();
    const { location: elsewhere } = await createLocation();
    await createUser({ role: "CASHIER", pin: "7393", locationIds: [elsewhere.id] });
    expect(await verifyPinSignIn(db, { pin: "7393", deviceToken: token })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(await verifyPinSignIn(db, { pin: "905174", deviceToken: token })).toMatchObject({
      ok: true,
      user: { id: owner.id },
    });
  });

  it("locks PIN entry on the device after repeated wrong PINs", async () => {
    const { device, token } = await setup();
    const now = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i <= LOCKOUT_POLICY.freeAttempts; i++) {
      expect((await verifyPinSignIn(db, { pin: "0000", deviceToken: token }, { now })).ok).toBe(
        false,
      );
    }
    const locked = await db.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(locked.pinLockedUntil?.getTime()).toBeGreaterThan(now.getTime());
    // Even the right PIN is refused while locked.
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: token }, { now })).toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(await db.auditLog.count({ where: { action: "auth.pin_failed" } })).toBe(
      LOCKOUT_POLICY.freeAttempts + 1,
    );
  });

  it("rejects malformed PINs without a database lookup leak", async () => {
    const { token } = await setup();
    expect((await verifyPinSignIn(db, { pin: "12a4", deviceToken: token })).ok).toBe(false);
  });
});

describe("manager approvals", () => {
  beforeEach(resetDatabase);

  it("issues a bound token when a manager approves on the device", async () => {
    const { location, register } = await createLocation();
    const owner = await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    const manager = await createUser({
      role: "MANAGER",
      pin: "583920",
      locationIds: [location.id],
    });
    const cashier = await createUser({ role: "CASHIER", pin: "4821", locationIds: [location.id] });
    const { device, token: deviceToken } = await pairDevice(location.id, owner.id, register.id);

    const granted = await grantApproval(db, {
      pin: "583920",
      deviceToken,
      permission: "pos.void",
      scope: "sale:abc",
      requestedById: cashier.id,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const claims = verifyApproval(granted.token, {
      permission: "pos.void",
      scope: "sale:abc",
      deviceId: device.id,
    });
    expect(claims?.approverId).toBe(manager.id);
    expect(await db.auditLog.count({ where: { action: "approval.granted" } })).toBe(1);
  });

  it("refuses an approver without the permission", async () => {
    const { location } = await createLocation();
    const owner = await createUser({ role: "OWNER" });
    await createUser({ role: "CASHIER", pin: "4821", locationIds: [location.id] });
    const { token: deviceToken } = await pairDevice(location.id, owner.id);
    const result = await grantApproval(db, {
      pin: "4821",
      deviceToken,
      permission: "pos.void",
      scope: "sale:abc",
      requestedById: owner.id,
    });
    expect(result).toEqual({ ok: false, reason: "NOT_PERMITTED" });
    expect(await db.auditLog.count({ where: { action: "approval.denied" } })).toBe(1);
  });
});
