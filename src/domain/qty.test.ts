import { describe, expect, it } from "vitest";
import { extend, formatQty, isValidQty, parseQty, units } from "./qty";

describe("parseQty", () => {
  it("parses weights with either decimal mark", () => {
    expect(parseQty("1.25", "KG")).toBe(1250);
    expect(parseQty("0,750", "KG")).toBe(750);
    expect(parseQty("2", "KG")).toBe(2000);
    expect(parseQty("0.001", "KG")).toBe(1);
  });

  it("requires whole pieces", () => {
    expect(parseQty("3", "PIECE")).toBe(3000);
    expect(parseQty("1.5", "PIECE")).toBeNull();
  });

  it.each(["", "0", "0.000", "-1", "1.2345", "abc", "1 000", "1,000.5"])("rejects %j", (input) => {
    expect(parseQty(input, "KG")).toBeNull();
  });

  it("rejects absurdly large quantities", () => {
    expect(parseQty("1000001", "KG")).toBeNull();
    expect(parseQty("1000000", "KG")).toBe(1_000_000_000);
  });
});

describe("isValidQty / units", () => {
  it("validates integers and unit granularity", () => {
    expect(isValidQty(1500, "KG")).toBe(true);
    expect(isValidQty(1500, "PIECE")).toBe(false);
    expect(isValidQty(0, "KG")).toBe(false);
    expect(isValidQty(1.5, "KG")).toBe(false);
  });

  it("units() converts whole counts", () => {
    expect(units(3)).toBe(3000);
    expect(() => units(1.5)).toThrow(RangeError);
  });
});

describe("formatQty", () => {
  it("formats pieces as integers and weights with up to 3 decimals", () => {
    expect(formatQty(3000, "PIECE")).toBe("3");
    expect(formatQty(1250, "KG")).toBe("1.25");
    expect(formatQty(1250, "KG", { fixedDecimals: true })).toBe("1.250");
    expect(formatQty(1, "KG")).toBe("0.001");
  });
});

describe("extend (unit price × quantity)", () => {
  it("prices weighed goods: 18,500₮/kg × 1.250 kg = 23,125₮", () => {
    expect(extend(1_850_000n, 1250)).toBe(2_312_500n);
  });

  it("rounds half away from zero to the möngö", () => {
    // 9.99₮/kg × 0.333 kg = 3.32667₮ → 3.33₮
    expect(extend(999n, 333)).toBe(333n);
    // 1₮ × 0.0005… not representable; 0.5 möngö rounds up
    expect(extend(1n, 500)).toBe(1n);
    expect(extend(1n, 499)).toBe(0n);
  });

  it("is exact for pieces", () => {
    expect(extend(250_000n, 3000)).toBe(750_000n);
  });
});
