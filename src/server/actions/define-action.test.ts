import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { hasPermission, type Permission } from "@/domain/permissions";
import type { CurrentUser } from "../auth/session";

const currentUser = vi.hoisted(() => ({ value: null as CurrentUser | null }));

vi.mock("../auth/session", () => ({
  getCurrentUser: async () => currentUser.value,
  can: (user: CurrentUser, permission: Permission, locationId?: string) =>
    hasPermission(user.role, permission) &&
    (!locationId || user.locationIds === "ALL" || user.locationIds.includes(locationId)),
}));
vi.mock("../request", () => ({
  requestMeta: async () => ({ ip: "203.0.113.1", userAgent: "test" }),
}));

const { ActionError, assertCan, defineAction, definePublicAction } =
  await import("./define-action");

const cashier: CurrentUser = {
  id: "u-cashier",
  name: "Cashier",
  email: null,
  role: "CASHIER",
  locale: null,
  locationIds: ["loc-1"],
  deviceId: "dev-1",
};
const manager: CurrentUser = { ...cashier, id: "u-manager", role: "MANAGER" };

const input = z.object({ qty: z.number().int().positive() });

describe("defineAction", () => {
  beforeEach(() => {
    currentUser.value = null;
  });

  it("checks authentication before validation, so anonymous callers learn nothing about the schema", async () => {
    const run = vi.fn();
    const action = defineAction({ name: "t", access: "pos.void", input, run });
    expect(await action({ qty: -1 })).toEqual({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses users without the permission", async () => {
    currentUser.value = cashier;
    const run = vi.fn();
    const action = defineAction({ name: "t", access: "pos.void", input, run });
    expect(await action({ qty: 1 })).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns field errors for invalid input", async () => {
    currentUser.value = manager;
    const action = defineAction({ name: "t", access: "pos.void", input, run: async () => "ok" });
    const result = await action({ qty: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(Object.keys(result.error.fieldErrors ?? {})).toEqual(["qty"]);
    }
  });

  it("passes parsed input, the user and request metadata to run()", async () => {
    currentUser.value = manager;
    const action = defineAction({
      name: "t",
      access: "authenticated",
      input: z.object({ name: z.string().trim() }),
      run: async (ctx) => ({ name: ctx.input.name, by: ctx.user.id, ip: ctx.meta.ip }),
    });
    expect(await action({ name: "  Сүү  " })).toEqual({
      ok: true,
      data: { name: "Сүү", by: "u-manager", ip: "203.0.113.1" },
    });
  });

  it("accepts FormData", async () => {
    currentUser.value = manager;
    const action = defineAction({
      name: "t",
      access: "authenticated",
      input: z.object({ name: z.string() }),
      run: async ({ input: parsed }) => parsed.name,
    });
    const form = new FormData();
    form.set("name", "Талх");
    expect(await action(form)).toEqual({ ok: true, data: "Талх" });
  });

  it("maps ActionError and known Prisma errors to stable codes", async () => {
    currentUser.value = manager;
    const failing = (error: unknown) =>
      defineAction({
        name: "t",
        access: "authenticated",
        input: z.object({}),
        run: async () => {
          throw error;
        },
      })({});
    const prismaError = (code: string) =>
      new Prisma.PrismaClientKnownRequestError("db", { code, clientVersion: "7.10.0" });
    expect(await failing(new ActionError("NOT_FOUND"))).toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await failing(prismaError("P2002"))).toEqual({ ok: false, error: { code: "CONFLICT" } });
    expect(await failing(prismaError("P2025"))).toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("hides unexpected errors behind INTERNAL", async () => {
    currentUser.value = manager;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const action = defineAction({
      name: "t",
      access: "authenticated",
      input: z.object({}),
      run: async () => {
        throw new Error("password=hunter2 leaked in a message");
      },
    });
    const result = await action({});
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    spy.mockRestore();
  });

  it("lets redirect() propagate instead of reporting it as an error", async () => {
    currentUser.value = manager;
    const action = defineAction({
      name: "t",
      access: "authenticated",
      input: z.object({}),
      run: async () => redirect("/dashboard"),
    });
    await expect(action({})).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });
});

describe("definePublicAction", () => {
  it("runs without a session and passes the (optional) user", async () => {
    currentUser.value = null;
    const action = definePublicAction({
      name: "t",
      input: z.object({}),
      run: async ({ user }) => user?.id ?? "anonymous",
    });
    expect(await action({})).toEqual({ ok: true, data: "anonymous" });
  });
});

describe("assertCan", () => {
  it("checks the permission at a specific location", () => {
    expect(() => assertCan(manager, "pos.void", "loc-1")).not.toThrow();
    expect(() => assertCan(manager, "pos.void", "loc-2")).toThrow(ActionError);
    expect(() => assertCan(cashier, "pos.void", "loc-1")).toThrow(ActionError);
  });
});
