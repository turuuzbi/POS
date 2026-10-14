import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  deviceToken: null as string | null,
  user: null as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name.endsWith("pos_device") && state.deviceToken
        ? { name, value: state.deviceToken }
        : undefined,
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/server/auth/session", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getCurrentUser: async () => state.user,
}));

import {
  browseCatalogAction,
  lookupCodeAction,
  refreshEntriesAction,
  searchCatalogAction,
} from "@/server/actions/register";
import { createDevice } from "@/server/auth/device";
import type { CurrentUser } from "@/server/auth/session";
import { db, resetDatabase } from "../support/db";
import { createStockedProduct, createTill } from "../support/checkout-fixtures";

function asUser(
  u: { id: string; role: CurrentUser["role"] },
  locationIds: CurrentUser["locationIds"],
  deviceId: string | null = null,
): CurrentUser {
  return { id: u.id, name: "t", email: null, role: u.role, locale: null, locationIds, deviceId };
}

describe("register catalog actions resolve the device like checkout does", () => {
  beforeEach(async () => {
    await resetDatabase();
    state.deviceToken = null;
    state.user = null;
  });
  afterAll(() => db.$disconnect());

  async function setup() {
    const tillB = await createTill();
    const { variant } = await createStockedProduct(tillB, { sku: "SKU-B", stockMilli: 7000 });
    const { token } = await createDevice(db, {
      locationId: tillB.location.id,
      registerId: tillB.register.id,
      name: "token holder",
      pairedById: tillB.manager.id,
    });
    return { tillB, variant, token };
  }

  it("serves stock of the device location to a user who may act there", async () => {
    const { tillB, variant, token } = await setup();
    state.deviceToken = token;
    state.user = asUser(tillB.cashier, [tillB.location.id]);
    const res = await lookupCodeAction({ code: "SKU-B" });
    expect(res.ok).toBe(true);
    const text = JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).toContain(variant.id);
    expect(text).toContain("7000");
  });

  it("refuses a user without access to the device's location, on every catalog action", async () => {
    const { variant, token } = await setup();
    const other = await createTill();
    state.deviceToken = token; // location B's device cookie
    state.user = asUser(other.cashier, [other.location.id]);
    const results = await Promise.all([
      searchCatalogAction({ query: "a" }),
      lookupCodeAction({ code: "SKU-B" }),
      browseCatalogAction({ categoryId: null }),
      refreshEntriesAction({ variantIds: [variant.id] }),
    ]);
    for (const res of results) {
      expect(res).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("refuses a PIN session opened on a different device, and a browser with no device", async () => {
    const { tillB, token } = await setup();
    state.deviceToken = token;
    state.user = asUser(tillB.cashier, [tillB.location.id], tillB.device.id); // other device
    expect(await searchCatalogAction({ query: "a" })).toEqual({
      ok: false,
      error: { code: "DEVICE_REQUIRED" },
    });
    state.deviceToken = null;
    state.user = asUser(tillB.cashier, [tillB.location.id]);
    expect(await browseCatalogAction({ categoryId: null })).toEqual({
      ok: false,
      error: { code: "DEVICE_REQUIRED" },
    });
  });
});
