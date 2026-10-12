/**
 * The real sign-in pipeline (server action → Auth.js signIn → authorize →
 * JWT cookie → getCurrentUser), with next/headers replaced by an in-memory
 * request: headers + cookie jar.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  extraHeaders: {} as Record<string, string>,
}));

vi.mock("next/headers", () => {
  const cookieStore = {
    get: (name: string) =>
      request.jar.has(name) ? { name, value: request.jar.get(name)! } : undefined,
    getAll: () => [...request.jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => request.jar.has(name),
    set: (
      nameOrCookie: string | { name: string; value: string; maxAge?: number },
      value?: string,
      options?: { maxAge?: number; expires?: Date },
    ) => {
      const cookie =
        typeof nameOrCookie === "string"
          ? { name: nameOrCookie, value: value ?? "", ...options }
          : nameOrCookie;
      const expired =
        cookie.maxAge === 0 ||
        cookie.value === "" ||
        ("expires" in cookie &&
          cookie.expires instanceof Date &&
          cookie.expires.getTime() < Date.now());
      if (expired) request.jar.delete(cookie.name);
      else request.jar.set(cookie.name, cookie.value);
    },
    delete: (name: string) => request.jar.delete(name),
  };
  return {
    cookies: async () => cookieStore,
    headers: async () =>
      new Headers({
        host: "localhost:3000",
        "x-forwarded-proto": "http",
        "user-agent": "vitest",
        "x-forwarded-for": "203.0.113.50",
        cookie: [...request.jar].map(([name, value]) => `${name}=${value}`).join("; "),
        ...request.extraHeaders,
      }),
  };
});

const { loginWithPassword, loginWithPin, logout } = await import("@/server/actions/auth");
const { getCurrentUser } = await import("@/server/auth/session");
const { DEVICE_COOKIE } = await import("@/server/auth/device");
const { throttleKeys } = await import("@/server/auth/throttle");
const { db, resetDatabase } = await import("../support/db");
const { createLocation, createUser, pairDevice } = await import("../support/fixtures");

const SESSION_COOKIE = "authjs.session-token";
const PASSWORD = "correct horse battery";

async function setup() {
  await resetDatabase();
  request.jar.clear();
  request.extraHeaders = {};
  const { location, register } = await createLocation();
  const owner = await createUser({ role: "OWNER", email: "o@shop.mn", password: PASSWORD });
  const cashier = await createUser({ role: "CASHIER", pin: "4821", locationIds: [location.id] });
  await db.user.update({ where: { id: cashier.id }, data: { locale: "en" } });
  const { device, token } = await pairDevice(location.id, owner.id, register.id);
  request.jar.set(DEVICE_COOKIE, token);
  return { location, owner, cashier, device, token };
}

const redirectTo = (path: string) => ({
  digest: expect.stringMatching(new RegExp(`^NEXT_REDIRECT;\\w+;${path.replace(/\//g, "\\/")};`)),
});

describe("PIN sign-in through Auth.js", () => {
  beforeEach(setup);
  afterAll(() => db.$disconnect());

  it("creates a session bound to the device and applies the saved locale", async () => {
    await expect(loginWithPin({ pin: "4821" })).rejects.toMatchObject(redirectTo("/"));
    expect(request.jar.has(SESSION_COOKIE)).toBe(true);
    expect(request.jar.get("NEXT_LOCALE")).toBe("en");
    const user = await getCurrentUser();
    expect(user).toMatchObject({ role: "CASHIER", locationIds: expect.any(Array) });
    expect(user?.deviceId).not.toBeNull();
  });

  it("reports a locked device as RATE_LIMITED", async () => {
    const { device } = await setup();
    await db.authThrottle.create({
      data: {
        key: throttleKeys.device(device.id),
        failures: 9,
        windowStart: new Date(),
        lastFailureAt: new Date(),
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    expect(await loginWithPin({ pin: "4821" })).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });
});

describe("sign-in cannot be turned into an oracle", () => {
  beforeEach(setup);

  it("X-Auth-Return-Redirect on an unpaired machine: no session, no locale cookie", async () => {
    request.jar.delete(DEVICE_COOKIE);
    request.extraHeaders = { "x-auth-return-redirect": "1" };
    expect(await loginWithPin({ pin: "4821" })).toEqual({
      ok: false,
      error: { code: "INVALID_CREDENTIALS" },
    });
    expect(request.jar.has("NEXT_LOCALE")).toBe(false);
    expect(request.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("a malformed callback-url cookie (authorize never runs) is a plain failure", async () => {
    request.jar.set("authjs.callback-url", "javascript%3Ax");
    for (const pin of ["4821", "9999"]) {
      expect(await loginWithPin({ pin })).toEqual({
        ok: false,
        error: { code: "INVALID_CREDENTIALS" },
      });
    }
    expect(request.jar.has("NEXT_LOCALE")).toBe(false);
    expect(request.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("the same holds for email sign-in", async () => {
    await db.user.update({ where: { email: "o@shop.mn" }, data: { locale: "en" } });
    request.extraHeaders = { "x-auth-return-redirect": "1" };
    expect(await loginWithPassword({ email: "o@shop.mn", password: "wrong-password" })).toEqual({
      ok: false,
      error: { code: "INVALID_CREDENTIALS" },
    });
    expect(request.jar.has("NEXT_LOCALE")).toBe(false);
  });
});

describe("password sign-in", () => {
  beforeEach(setup);

  it("never redirects off-site, whatever `next` says", async () => {
    await expect(
      loginWithPassword({ email: "o@shop.mn", password: PASSWORD, next: "/\t/evil.example" }),
    ).rejects.toMatchObject(redirectTo("/"));
    request.jar.delete(SESSION_COOKIE);
    await expect(
      loginWithPassword({ email: "o@shop.mn", password: PASSWORD, next: "/settings/devices" }),
    ).rejects.toMatchObject(redirectTo("/settings/devices"));
  });
});

describe("getCurrentUser re-validates every request", () => {
  beforeEach(setup);

  async function signInCashier() {
    await expect(loginWithPin({ pin: "4821" })).rejects.toMatchObject(redirectTo("/"));
    expect(await getCurrentUser()).not.toBeNull();
  }

  it("rejects a deactivated user", async () => {
    await signInCashier();
    await db.user.updateMany({ where: { role: "CASHIER" }, data: { isActive: false } });
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejects a session after a tokenVersion bump (role change, password reset)", async () => {
    await signInCashier();
    await db.user.updateMany({
      where: { role: "CASHIER" },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejects a PIN session once its device is revoked", async () => {
    const { device } = await setup();
    await signInCashier();
    await db.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejects a PIN session replayed without the device cookie, or with another device's", async () => {
    const { location, owner } = await setup();
    await signInCashier();
    const token = request.jar.get(DEVICE_COOKIE)!;
    request.jar.delete(DEVICE_COOKIE);
    expect(await getCurrentUser()).toBeNull();
    const other = await pairDevice(location.id, owner.id);
    request.jar.set(DEVICE_COOKIE, other.token);
    expect(await getCurrentUser()).toBeNull();
    request.jar.set(DEVICE_COOKIE, token);
    expect(await getCurrentUser()).not.toBeNull();
  });

  it("revokes the session on sign-out, so a copied cookie stops working", async () => {
    await signInCashier();
    const copied = request.jar.get(SESSION_COOKIE)!;
    await expect(logout({})).rejects.toMatchObject(redirectTo("/pin"));
    expect(request.jar.has(SESSION_COOKIE)).toBe(false);
    expect(await db.revokedSession.count()).toBe(1);
    request.jar.set(SESSION_COOKIE, copied);
    expect(await getCurrentUser()).toBeNull();
  });

  it("lets a stale screen sign out even when the session is already invalid", async () => {
    await signInCashier();
    await db.user.updateMany({ where: { role: "CASHIER" }, data: { isActive: false } });
    await expect(logout({})).rejects.toMatchObject(redirectTo("/pin"));
  });
});
