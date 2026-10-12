import { describe, expect, it } from "vitest";
import { can, canAccessLocation, type AccessSubject } from "./access";

const owner: AccessSubject = { role: "OWNER", locationIds: "ALL" };
const manager: AccessSubject = { role: "MANAGER", locationIds: ["loc-1"] };
const unassigned: AccessSubject = { role: "MANAGER", locationIds: [] };
const cashier: AccessSubject = { role: "CASHIER", locationIds: ["loc-1"] };

describe("canAccessLocation", () => {
  it("owners reach every location; others only their own", () => {
    expect(canAccessLocation(owner, "anywhere")).toBe(true);
    expect(canAccessLocation(manager, "loc-1")).toBe(true);
    expect(canAccessLocation(manager, "loc-2")).toBe(false);
    expect(canAccessLocation(unassigned, "loc-1")).toBe(false);
  });
});

describe("can", () => {
  it("requires both the permission and (when given) the location", () => {
    expect(can(manager, "devices.manage", "loc-1")).toBe(true);
    expect(can(manager, "devices.manage", "loc-2")).toBe(false);
    expect(can(cashier, "devices.manage", "loc-1")).toBe(false);
    expect(can(owner, "devices.manage", "loc-9")).toBe(true);
  });

  it("checks only the permission when no location is given", () => {
    expect(can(manager, "devices.manage")).toBe(true);
    expect(can(unassigned, "devices.manage")).toBe(true);
    expect(can(cashier, "devices.manage")).toBe(false);
  });

  it("treats an empty-string location as a location (not 'no location')", () => {
    expect(can(manager, "devices.manage", "")).toBe(false);
  });
});
