import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { grantApproval, verifyApproval } from "@/server/auth/approval";
import { verifyPasswordSignIn, verifyPinSignIn } from "@/server/auth/credentials";
import { THROTTLE_RULES } from "@/server/auth/lockout";
import { emailKey, throttleKeys } from "@/server/auth/throttle";
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

  it("locks the account for that source after repeated failures, even for the right password", async () => {
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const attacker = { now, ip: "203.0.113.7" };
    const rule = THROTTLE_RULES.accountFromSource;
    for (let i = 0; i <= rule.freeAttempts; i++) {
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: "wrong password!" }, attacker);
    }
    const key = throttleKeys.accountFromSource(emailKey("m@shop.mn"), attacker.ip);
    const bucket = await db.authThrottle.findUniqueOrThrow({ where: { key } });
    expect(bucket.failures).toBe(rule.freeAttempts + 1);
    expect(bucket.lockedUntil?.getTime()).toBeGreaterThan(now.getTime());

    // Locked from the attacker's address, even with the right password…
    expect(
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: PASSWORD }, attacker),
    ).toEqual({ ok: false, reason: "INVALID" });
    // …but the real manager signing in from elsewhere is not locked out.
    const elsewhere = await verifyPasswordSignIn(
      db,
      { email: "m@shop.mn", password: PASSWORD },
      { now, ip: "198.51.100.20" },
    );
    expect(elsewhere.ok).toBe(true);
    // The attacker's own bucket stays locked.
    expect(
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: PASSWORD }, attacker),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("counts failures in fixed windows: a new window starts fresh", async () => {
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const ip = "203.0.113.8";
    const rule = THROTTLE_RULES.accountFromSource;
    const start = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i < rule.freeAttempts; i++) {
      await verifyPasswordSignIn(
        db,
        { email: "m@shop.mn", password: "nope nope nope" },
        { now: start, ip },
      );
    }
    const later = new Date(start.getTime() + rule.windowMs + 1);
    await verifyPasswordSignIn(
      db,
      { email: "m@shop.mn", password: "nope nope nope" },
      { now: later, ip },
    );
    const bucket = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.accountFromSource(emailKey("m@shop.mn"), ip) },
    });
    expect(bucket.failures).toBe(1);
    expect(bucket.lockedUntil).toBeNull();
  });

  it("a slow drip of failures can't keep escalating the lock", async () => {
    await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    const ip = "203.0.113.11";
    const start = new Date("2026-05-01T00:00:00Z").getTime();
    // One wrong password every 15 minutes for 24 hours.
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: "drip drip drip" },
        { now: new Date(start + minute * 60_000), ip },
      );
    }
    // Shortly after the last drip, the owner from their usual place still gets in.
    const result = await verifyPasswordSignIn(
      db,
      { email: "o@shop.mn", password: PASSWORD },
      { now: new Date(start + 24 * 60 * 60_000), ip: "198.51.100.1" },
    );
    expect(result.ok).toBe(true);
  });

  it("a distributed attack can't lock the owner out of a source they've used before", async () => {
    await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const shop = "198.51.100.10";
    expect(
      (
        await verifyPasswordSignIn(
          db,
          { email: "o@shop.mn", password: PASSWORD },
          { now, ip: shop },
        )
      ).ok,
    ).toBe(true);
    // Guessing from many addresses trips the account-wide bucket…
    for (let i = 0; i <= THROTTLE_RULES.account.freeAttempts; i++) {
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: `guess-${i}-guess` },
        { now, ip: `203.0.113.${100 + i}` },
      );
    }
    // …which blocks new sources, even with the right password…
    expect(
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: PASSWORD },
        { now, ip: "192.0.2.77" },
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
    // …but not the owner's trusted shop network.
    expect(
      (
        await verifyPasswordSignIn(
          db,
          { email: "o@shop.mn", password: PASSWORD },
          { now, ip: shop },
        )
      ).ok,
    ).toBe(true);
    // Signing in there doesn't lift the lock the attackers face.
    expect(
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: PASSWORD },
        { now, ip: "192.0.2.78" },
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("checks at most freeAttempts + 1 passwords from a parallel burst", async () => {
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const ip = "203.0.113.30";
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        verifyPasswordSignIn(db, { email: "m@shop.mn", password: `guess-${i}-guess` }, { now, ip }),
      ),
    );
    // Only checked attempts reach the source bucket; refused ones count on
    // the account+source bucket alone.
    const source = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.source(ip) },
    });
    expect(source.failures).toBe(THROTTLE_RULES.accountFromSource.freeAttempts + 1);
    const accountFromSource = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.accountFromSource(emailKey("m@shop.mn"), ip) },
    });
    expect(accountFromSource.failures).toBe(16);
  });

  it("one source can't trip the account-wide lock for everyone else", async () => {
    await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i <= THROTTLE_RULES.account.freeAttempts + 5; i++) {
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: `guess-${i}-guess` },
        { now, ip: "203.0.113.40" },
      );
    }
    const result = await verifyPasswordSignIn(
      db,
      { email: "o@shop.mn", password: PASSWORD },
      { now, ip: "198.51.100.44" },
    );
    expect(result.ok).toBe(true);
  });

  it("a known browser can't be locked out by others on the same network", async () => {
    await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const shop = "198.51.100.10";
    const first = await verifyPasswordSignIn(
      db,
      { email: "o@shop.mn", password: PASSWORD },
      { now, ip: shop },
    );
    if (!first.ok) throw new Error("first sign-in failed");
    const cookie = first.knownBrowser;
    expect(cookie).toBeTruthy();

    // Someone on the shop Wi-Fi sprays the sign-in form and guesses the owner's password.
    for (let i = 0; i <= THROTTLE_RULES.source.freeAttempts; i++) {
      await verifyPasswordSignIn(
        db,
        { email: i % 2 ? "o@shop.mn" : `x${i}@shop.mn`, password: "wrong-wrong" },
        { now, ip: shop },
      );
    }
    // A new browser at the shop is now refused…
    expect(
      (
        await verifyPasswordSignIn(
          db,
          { email: "o@shop.mn", password: PASSWORD },
          { now, ip: shop },
        )
      ).ok,
    ).toBe(false);
    // …but the owner's own browser still gets in.
    expect(
      (
        await verifyPasswordSignIn(
          db,
          { email: "o@shop.mn", password: PASSWORD },
          { now, ip: shop, knownBrowser: cookie },
        )
      ).ok,
    ).toBe(true);
  });

  it("a known-browser cookie only counts for the account that signed in with it", async () => {
    await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const ip = "203.0.113.60";
    const mine = await verifyPasswordSignIn(
      db,
      { email: "m@shop.mn", password: PASSWORD },
      { now, ip },
    );
    if (!mine.ok) throw new Error("sign-in failed");
    // Guessing the owner's password with the manager's cookie uses the ordinary buckets.
    for (let i = 0; i <= THROTTLE_RULES.accountFromSource.freeAttempts; i++) {
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: `guess-${i}-guess` },
        { now, ip, knownBrowser: mine.knownBrowser },
      );
    }
    expect(
      await db.authThrottle.findUnique({
        where: { key: throttleKeys.accountFromSource(emailKey("o@shop.mn"), ip) },
      }),
    ).toMatchObject({ failures: THROTTLE_RULES.accountFromSource.freeAttempts + 1 });
    // A forged cookie is ignored too.
    const forged = `${"A".repeat(22)}.${"B".repeat(22)}`;
    expect(
      await verifyPasswordSignIn(
        db,
        { email: "o@shop.mn", password: PASSWORD },
        { now, ip, knownBrowser: forged },
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("bounds an attacker rotating through IPv6 /64s within one /48", async () => {
    const now = new Date("2026-05-01T09:00:00Z");
    let refused = false;
    for (let i = 0; i <= THROTTLE_RULES.sourceNetwork.freeAttempts + 1; i++) {
      const ip = `2001:db8:77:${i.toString(16)}::1`;
      const result = await verifyPasswordSignIn(
        db,
        { email: `spray${i}@shop.mn`, password: "wrong-wrong" },
        { now, ip },
      );
      if (!result.ok && result.reason === "RATE_LIMITED") refused = true;
    }
    expect(refused).toBe(true);
  });

  it("answers identically for real and unknown emails (no existence oracle)", async () => {
    await createUser({ role: "MANAGER", email: "real@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    const probe = async (email: string, ip: string) => {
      const answers: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await verifyPasswordSignIn(db, { email, password: "wrong-wrong" }, { now, ip });
        answers.push(r.ok ? "ok" : r.reason);
      }
      for (let i = 0; i < THROTTLE_RULES.source.freeAttempts; i++) {
        const r = await verifyPasswordSignIn(
          db,
          { email: `filler${i}@shop.mn`, password: "wrong-wrong" },
          { now, ip },
        );
        answers.push(r.ok ? "ok" : r.reason);
      }
      return answers;
    };
    const real = await probe("real@shop.mn", "203.0.113.20");
    const unknown = await probe("ghost@shop.mn", "203.0.113.21");
    expect(real).toEqual(unknown);
    expect(real.at(-1)).toBe("RATE_LIMITED");
  });

  it("never lets a malformed client address escape throttling", async () => {
    await createUser({ role: "MANAGER", email: "m@shop.mn", password: PASSWORD });
    const now = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i <= THROTTLE_RULES.accountFromSource.freeAttempts; i++) {
      const ip = `${"f".repeat(3000)}${i}`; // oversized, rotating "X-Forwarded-For"
      await verifyPasswordSignIn(db, { email: "m@shop.mn", password: "wrong pass!" }, { now, ip });
    }
    expect(
      await verifyPasswordSignIn(
        db,
        { email: "m@shop.mn", password: PASSWORD },
        { now, ip: "f".repeat(3000) },
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("rate-limits a source that sprays many accounts, and audits unknown emails", async () => {
    const now = new Date("2026-05-01T09:00:00Z");
    const ip = "203.0.113.9";
    for (let i = 0; i <= THROTTLE_RULES.source.freeAttempts; i++) {
      await verifyPasswordSignIn(
        db,
        { email: `nobody${i}@shop.mn`, password: "x".repeat(12) },
        { now, ip },
      );
    }
    expect(
      await verifyPasswordSignIn(
        db,
        { email: "any@shop.mn", password: "x".repeat(12) },
        { now, ip },
      ),
    ).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(
      await db.auditLog.count({ where: { action: "auth.login_failed", entityId: null } }),
    ).toBe(THROTTLE_RULES.source.freeAttempts + 2);
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

  it("locks PIN entry on the device after repeated wrong PINs and reports it as locked", async () => {
    const { device, token } = await setup();
    const now = new Date("2026-05-01T09:00:00Z");
    for (let i = 0; i <= THROTTLE_RULES.device.freeAttempts; i++) {
      expect(await verifyPinSignIn(db, { pin: "000000", deviceToken: token }, { now })).toEqual({
        ok: false,
        reason: "INVALID",
      });
    }
    const bucket = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.device(device.id) },
    });
    expect(bucket.lockedUntil?.getTime()).toBeGreaterThan(now.getTime());
    // Even the right PIN is refused while locked — and the reason says "locked", not "wrong PIN".
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: token }, { now })).toEqual({
      ok: false,
      reason: "LOCKED",
    });
    expect(await db.auditLog.count({ where: { action: "auth.pin_failed" } })).toBe(
      THROTTLE_RULES.device.freeAttempts + 1,
    );
    // After the lock expires the right PIN works, and gives back only its own attempt.
    const after = new Date(bucket.lockedUntil!.getTime() + 1);
    expect(
      (await verifyPinSignIn(db, { pin: "4821", deviceToken: token }, { now: after })).ok,
    ).toBe(true);
    const settled = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.device(device.id) },
    });
    expect(settled.failures).toBe(THROTTLE_RULES.device.freeAttempts + 1);
  });

  it("a correct PIN never resets other people's wrong guesses on the device", async () => {
    const { cashier, token } = await setup();
    const now = new Date("2026-05-01T09:00:00Z");
    // Guess, then sign in with your own PIN to "reset" the counter, and repeat.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) {
        await verifyPinSignIn(db, { pin: `11${round}${i}`, deviceToken: token }, { now });
      }
      const own = await verifyPinSignIn(db, { pin: "4821", deviceToken: token }, { now });
      if (!own.ok) {
        expect(own).toEqual({ ok: false, reason: "LOCKED" });
        return;
      }
      expect(own.user.id).toBe(cashier.id);
    }
    // 9 wrong guesses in the hour: the device must be locked by now.
    expect(await verifyPinSignIn(db, { pin: "4821", deviceToken: token }, { now })).toEqual({
      ok: false,
      reason: "LOCKED",
    });
  });

  it("checks at most freeAttempts + 1 PINs from a parallel burst", async () => {
    const { device, token } = await setup();
    const now = new Date("2026-05-01T09:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        verifyPinSignIn(db, { pin: String(100000 + i), deviceToken: token }, { now }),
      ),
    );
    const checked = results.filter((r) => !r.ok && r.reason === "INVALID").length;
    expect(checked).toBe(THROTTLE_RULES.device.freeAttempts + 1);
    expect(results.filter((r) => !r.ok && r.reason === "LOCKED")).toHaveLength(20 - checked);
    expect(await db.auditLog.count({ where: { action: "auth.pin_failed" } })).toBe(checked);
    // Locked attempts don't extend the lock.
    const bucket = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.device(device.id) },
    });
    expect(bucket.failures).toBe(checked);
  });

  it("caps PIN guesses per device per day, beyond the hourly allowance", async () => {
    const { token } = await setup();
    const start = new Date("2026-05-01T00:00:00Z").getTime();
    let guess = 0;
    // Spend the hourly allowance every hour, never tripping the hourly lock.
    for (let hour = 0; hour < 24; hour++) {
      for (let i = 0; i < THROTTLE_RULES.device.freeAttempts; i++) {
        const now = new Date(start + hour * 3_600_000 + i * 1000);
        const result = await verifyPinSignIn(
          db,
          { pin: String(200000 + guess++), deviceToken: token },
          { now },
        );
        if (!result.ok && result.reason === "LOCKED") {
          expect(guess).toBeGreaterThan(THROTTLE_RULES.deviceDaily.freeAttempts);
          return;
        }
      }
    }
    throw new Error("the daily PIN bucket never locked");
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

  it("treats a PIN without the permission exactly like a wrong PIN", async () => {
    const { location } = await createLocation();
    const owner = await createUser({ role: "OWNER" });
    await createUser({ role: "CASHIER", pin: "4821", locationIds: [location.id] });
    const { device, token: deviceToken } = await pairDevice(location.id, owner.id);
    const ask = (pin: string) =>
      grantApproval(db, {
        pin,
        deviceToken,
        permission: "pos.void",
        scope: "sale:abc",
        requestedById: owner.id,
      });
    // A cashier's real PIN and a PIN nobody has get the same answer…
    expect(await ask("4821")).toEqual({ ok: false, reason: "INVALID" });
    expect(await ask("9999")).toEqual({ ok: false, reason: "INVALID" });
    // …and both count against the device.
    const bucket = await db.authThrottle.findUniqueOrThrow({
      where: { key: throttleKeys.device(device.id) },
    });
    expect(bucket.failures).toBe(2);
    expect(
      await db.auditLog.count({
        where: { action: "auth.pin_failed", meta: { path: ["purpose"], equals: "approval" } },
      }),
    ).toBe(2);
  });
});
