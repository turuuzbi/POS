import { describe, expect, it } from "vitest";
import {
  escapeLike,
  nextDay,
  parseDay,
  parseSalesFilter,
  salesFilterParams,
  zonedDayStart,
} from "./sales-filter";

describe("zoned days", () => {
  it("starts an Ulaanbaatar day at 16:00Z the evening before", () => {
    expect(zonedDayStart("2026-10-15")!.toISOString()).toBe("2026-10-14T16:00:00.000Z");
    expect(zonedDayStart("2026-01-01", "Asia/Ulaanbaatar")!.toISOString()).toBe(
      "2025-12-31T16:00:00.000Z",
    );
  });
  it("follows another zone's offset, DST included", () => {
    expect(zonedDayStart("2026-07-01", "America/New_York")!.toISOString()).toBe(
      "2026-07-01T04:00:00.000Z",
    );
    expect(zonedDayStart("2026-01-01", "America/New_York")!.toISOString()).toBe(
      "2026-01-01T05:00:00.000Z",
    );
  });
  it("rejects impossible days", () => {
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("15.10.2026")).toBeNull();
    expect(zonedDayStart("nope")).toBeNull();
  });
  it("rolls month and year ends", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });
});

describe("parseSalesFilter", () => {
  const LOC = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  it("returns an empty filter for no parameters", () => {
    const f = parseSalesFilter({});
    expect(f).toMatchObject({
      from: null,
      to: null,
      locationId: null,
      method: null,
      status: null,
      q: null,
      minAmount: null,
      maxAmount: null,
      page: 1,
      invalid: [],
    });
  });

  it("makes the end date inclusive (end of that local day)", () => {
    const f = parseSalesFilter({ from: "2026-10-14", to: "2026-10-15" });
    expect(f.from!.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(f.to!.toISOString()).toBe("2026-10-15T16:00:00.000Z");
    expect(f.fromDay).toBe("2026-10-14");
  });

  it("drops an inverted range's end and reports it", () => {
    const f = parseSalesFilter({ from: "2026-10-15", to: "2026-10-01" });
    expect(f.to).toBeNull();
    expect(f.invalid).toContain("to");
  });

  it("validates ids, enums and amounts without throwing", () => {
    const f = parseSalesFilter({
      location: LOC.toUpperCase(),
      register: "not-a-uuid",
      method: "BITCOIN",
      status: "PARTIALLY_REFUNDED",
      min: "1,000.50",
      max: "abc",
      page: "-3",
    });
    expect(f.locationId).toBe(LOC);
    expect(f.registerId).toBeNull();
    expect(f.method).toBeNull();
    expect(f.status).toBe("PARTIALLY_REFUNDED");
    expect(f.minAmount).toBe(100_050n);
    expect(f.maxAmount).toBeNull();
    expect(f.page).toBe(1);
    expect(f.invalid.sort()).toEqual(["max", "method", "register"]);
  });

  it("swaps a reversed amount range", () => {
    const f = parseSalesFilter({ min: "500", max: "100" });
    expect(f.minAmount).toBe(10_000n);
    expect(f.maxAmount).toBe(50_000n);
  });

  it("takes the first of repeated parameters and truncates the search", () => {
    const f = parseSalesFilter({ q: ["UB1", "x"], page: ["4", "5"] });
    expect(f.q).toBe("UB1");
    expect(f.page).toBe(4);
    expect(parseSalesFilter({ q: "x".repeat(500) }).q).toHaveLength(40);
  });

  it("round-trips through salesFilterParams", () => {
    const f = parseSalesFilter({
      from: "2026-10-01",
      method: "CASH",
      min: "10.50",
      max: "200",
      q: "UB",
    });
    expect(salesFilterParams(f)).toMatchObject({
      from: "2026-10-01",
      method: "CASH",
      min: "10.50",
      max: "200",
      q: "UB",
    });
  });
});

describe("escapeLike", () => {
  it("makes wildcards literal", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
