import { describe, expect, it } from "vitest";
import { countVariance, movingAverageCost } from "./inventory";
import { fromMajor } from "./money";
import { units } from "./qty";

describe("movingAverageCost", () => {
  it("weights the existing stock and the receipt by quantity", () => {
    // 10 pcs at 1,000₮ + 30 pcs at 2,000₮ → 1,750₮
    expect(movingAverageCost(units(10), fromMajor(1000), units(30), fromMajor(2000))).toBe(
      fromMajor(1750),
    );
  });

  it("works in milli-units for weighed goods and rounds once", () => {
    // 1.250 kg at 10,000₮/kg + 0.333 kg at 12,000₮/kg
    // = (1250×1,000,000 + 333×1,200,000) / 1583 = 1,042,072.015… möngö
    expect(movingAverageCost(1250, 1_000_000n, 333, 1_200_000n)).toBe(1_042_072n);
    // …and half rounds up: (1×1 + 1×2) / 2 = 1.5 → 2
    expect(movingAverageCost(1, 1n, 1, 2n)).toBe(2n);
  });

  it("takes the received cost when nothing (or less than nothing) is on hand", () => {
    expect(movingAverageCost(0, fromMajor(500), units(5), fromMajor(800))).toBe(fromMajor(800));
    expect(movingAverageCost(units(-3), fromMajor(500), units(5), fromMajor(800))).toBe(
      fromMajor(800),
    );
  });

  it("rejects a non-positive receipt", () => {
    expect(() => movingAverageCost(units(1), 1n, 0, 1n)).toThrow(RangeError);
  });
});

describe("countVariance", () => {
  it("is counted minus on hand", () => {
    expect(countVariance(units(10), units(8))).toBe(units(-2));
    expect(countVariance(units(-1), 0)).toBe(units(1));
  });
});
