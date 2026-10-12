import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  APPROVABLE_PERMISSIONS,
  hasPermission,
  isApprovable,
  permissionsFor,
} from "./permissions";

describe("role hierarchy", () => {
  it("owner ⊇ manager ⊇ cashier", () => {
    const owner = new Set(permissionsFor("OWNER"));
    const manager = new Set(permissionsFor("MANAGER"));
    for (const p of permissionsFor("CASHIER")) expect(manager.has(p)).toBe(true);
    for (const p of manager) expect(owner.has(p)).toBe(true);
  });

  it("owner holds every permission", () => {
    for (const p of ALL_PERMISSIONS) expect(hasPermission("OWNER", p)).toBe(true);
  });

  it("keeps user, settings and location management owner-only", () => {
    for (const p of ["users.manage", "settings.manage", "locations.manage"] as const) {
      expect(hasPermission("MANAGER", p)).toBe(false);
      expect(hasPermission("CASHIER", p)).toBe(false);
    }
  });

  it("cashiers can sell but not override, void, refund or see costs", () => {
    expect(hasPermission("CASHIER", "pos.sell")).toBe(true);
    for (const p of [
      "pos.price_override",
      "pos.void",
      "pos.refund",
      "reports.view_costs",
    ] as const) {
      expect(hasPermission("CASHIER", p)).toBe(false);
    }
  });
});

describe("approvable permissions", () => {
  it("are exactly the ones a manager holds and a cashier lacks", () => {
    for (const p of APPROVABLE_PERMISSIONS) {
      expect(hasPermission("MANAGER", p)).toBe(true);
      expect(hasPermission("CASHIER", p)).toBe(false);
      expect(isApprovable(p)).toBe(true);
    }
    expect(isApprovable("users.manage")).toBe(false);
  });
});
