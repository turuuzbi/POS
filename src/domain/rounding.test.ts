import { describe, expect, it } from "vitest";
import { ALLOWED_ROUNDING_UNITS, DEFAULT_ROUNDING_UNIT, roundTotal } from "./rounding";

describe("roundTotal", () => {
  it("defaults to whole tögrög", () => {
    expect(DEFAULT_ROUNDING_UNIT).toBe(100n);
    expect(roundTotal(1_234_549n)).toEqual({
      total: 1_234_549n,
      roundingAmount: -49n,
      payable: 1_234_500n,
    });
    expect(roundTotal(1_234_550n).payable).toBe(1_234_600n);
    expect(roundTotal(1_234_550n).roundingAmount).toBe(50n);
  });

  it("supports 5₮ and 10₮ cash rounding", () => {
    expect(roundTotal(1_237_00n, 500n).payable).toBe(1_235_00n);
    expect(roundTotal(1_237_50n, 500n).payable).toBe(1_240_00n);
    expect(roundTotal(1_249_99n, 1000n).payable).toBe(1_250_00n);
    expect(roundTotal(1_244_99n, 1000n).payable).toBe(1_240_00n);
  });

  it("exact unit 1 never rounds", () => {
    expect(roundTotal(12_345n, 1n).roundingAmount).toBe(0n);
  });

  it("rejects bad input", () => {
    expect(() => roundTotal(-1n)).toThrow(RangeError);
    expect(() => roundTotal(1n, 0n)).toThrow(RangeError);
  });

  it("total + roundingAmount = payable, multiple of unit, |rounding| ≤ unit/2", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let i = 0; i < 3000; i++) {
      const total = BigInt(next() % 100_000_000);
      const unit = ALLOWED_ROUNDING_UNITS[next() % ALLOWED_ROUNDING_UNITS.length]!;
      const r = roundTotal(total, unit);
      expect(r.total + r.roundingAmount).toBe(r.payable);
      expect(r.payable % unit).toBe(0n);
      expect(r.roundingAmount * 2n <= unit && -r.roundingAmount * 2n <= unit).toBe(true);
    }
  });
});
