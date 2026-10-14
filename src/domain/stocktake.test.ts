import { describe, expect, it } from "vitest";
import { addToCount, summarizeVariance, varianceValue } from "./inventory";
import { units } from "./qty";

describe("stocktake helpers", () => {
  it("values a variance at the unit cost, signed", () => {
    expect(varianceValue(units(-3), 200_000n)).toBe(-600_000n);
    expect(varianceValue(250, 1_000_000n)).toBe(250_000n);
  });

  it("adds scans to the counted quantity and refuses out-of-range results", () => {
    expect(addToCount(null, units(1))).toBe(units(1));
    expect(addToCount(units(2), units(1))).toBe(units(3));
    expect(() => addToCount(units(1), units(-2))).toThrow(RangeError);
  });

  it("summarises variances; uncounted lines only count with countAll", () => {
    const lines = [
      { expectedMilli: units(10), countedMilli: units(8), unitCost: 100_000n },
      { expectedMilli: units(5), countedMilli: units(6), unitCost: 200_000n },
      { expectedMilli: units(4), countedMilli: null, unitCost: 50_000n },
    ];
    expect(summarizeVariance(lines, false)).toMatchObject({
      counted: 2,
      uncounted: 1,
      surplusLines: 1,
      shortageLines: 1,
      surplusMilli: units(1),
      shortageMilli: units(2),
      netValue: 0n,
    });
    const all = summarizeVariance(lines, true);
    expect(all.shortageLines).toBe(2);
    expect(all.shortageMilli).toBe(units(6));
    expect(all.netValue).toBe(-200_000n);
  });
});
