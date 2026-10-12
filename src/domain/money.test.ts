import { describe, expect, it } from "vitest";
import {
  allocate,
  divRound,
  formatMoney,
  fromMajor,
  mulDiv,
  parseMoney,
  percentOf,
  roundToUnit,
  sum,
  type RoundingMode,
} from "./money";

describe("divRound", () => {
  // [numerator, denominator, mode, expected]
  const cases: Array<[bigint, bigint, RoundingMode, bigint]> = [
    [7n, 2n, "HALF_UP", 4n],
    [-7n, 2n, "HALF_UP", -4n],
    [5n, 2n, "HALF_EVEN", 2n],
    [7n, 2n, "HALF_EVEN", 4n],
    [-5n, 2n, "HALF_EVEN", -2n],
    [-7n, 2n, "HALF_EVEN", -4n],
    [7n, 3n, "HALF_UP", 2n],
    [8n, 3n, "HALF_UP", 3n],
    [7n, 2n, "DOWN", 3n],
    [-7n, 2n, "DOWN", -3n],
    [7n, 2n, "UP", 4n],
    [-7n, 2n, "UP", -4n],
    [7n, 2n, "FLOOR", 3n],
    [-7n, 2n, "FLOOR", -4n],
    [7n, 2n, "CEIL", 4n],
    [-7n, 2n, "CEIL", -3n],
    [6n, 3n, "UP", 2n], // exact division never rounds
    [7n, -2n, "HALF_UP", -4n], // negative denominator
    [-7n, -2n, "HALF_UP", 4n],
    [0n, 5n, "UP", 0n],
  ];
  it.each(cases)("%s / %s (%s) = %s", (n, d, mode, expected) => {
    expect(divRound(n, d, mode)).toBe(expected);
  });

  it("defaults to HALF_UP", () => {
    expect(divRound(15n, 10n)).toBe(2n);
    expect(divRound(14n, 10n)).toBe(1n);
  });

  it("rejects division by zero", () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });

  it("is exact for values far beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 10n ** 30n + 5n;
    expect(divRound(big, 10n)).toBe(10n ** 29n + 1n);
  });

  it("agrees with exact rational rounding across a dense grid", () => {
    for (let n = -200n; n <= 200n; n++) {
      for (const d of [1n, 2n, 3n, 7n, 10n, 11n, 100n]) {
        const q = divRound(n, d, "HALF_UP");
        // |n/d − q| ≤ 1/2, and ties go away from zero
        const diff2 = (n - q * d) * 2n; // = 2d·(n/d − q)
        expect(diff2 <= d && diff2 >= -d).toBe(true);
        if (diff2 === d) expect(n < 0n).toBe(true);
        if (diff2 === -d) expect(n > 0n).toBe(true);
      }
    }
  });
});

describe("mulDiv / percentOf", () => {
  it("rounds once, after multiplying", () => {
    // 1,999₮ × 10% = 199.90₮ exactly
    expect(percentOf(199_900n, 1000)).toBe(19_990n);
    // 33.33₮ × 1/3 → 11.11₮
    expect(mulDiv(3_333n, 1n, 3n)).toBe(1_111n);
  });

  it("extracts 10% VAT from an inclusive price (1,000₮ → 90.91₮)", () => {
    expect(mulDiv(100_000n, 1000n, 11_000n)).toBe(9_091n);
  });

  it("rejects fractional bps", () => {
    expect(() => percentOf(100n, 12.5)).toThrow(RangeError);
  });
});

describe("roundToUnit", () => {
  it("rounds to whole tögrög by default rules", () => {
    expect(roundToUnit(219_890n, 100n)).toBe(219_900n);
    expect(roundToUnit(219_849n, 100n)).toBe(219_800n);
    expect(roundToUnit(219_850n, 100n)).toBe(219_900n);
    expect(roundToUnit(-219_850n, 100n)).toBe(-219_900n);
  });

  it("supports coarser cash units (10₮)", () => {
    expect(roundToUnit(219_500n, 1_000n)).toBe(220_000n);
    expect(roundToUnit(219_499n, 1_000n)).toBe(219_000n);
  });

  it("rejects non-positive units", () => {
    expect(() => roundToUnit(1n, 0n)).toThrow(RangeError);
  });
});

describe("allocate", () => {
  it("splits proportionally and sums exactly", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(1_000n, [500n, 300n, 200n])).toEqual([500n, 300n, 200n]);
  });

  it("gives leftovers to the largest remainders, ties to earlier lines", () => {
    // 10 over weights 1:2:3 → 1.67, 3.33, 5 → [2, 3, 5]
    expect(allocate(10n, [1n, 2n, 3n])).toEqual([2n, 3n, 5n]);
    expect(allocate(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });

  it("handles negative totals symmetrically", () => {
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it("gives nothing to zero-weight lines", () => {
    expect(allocate(5n, [0n, 1n, 0n])).toEqual([0n, 5n, 0n]);
  });

  it("allows zero over zero weights, rejects non-zero", () => {
    expect(allocate(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(() => allocate(1n, [0n, 0n])).toThrow(RangeError);
    expect(() => allocate(1n, [-1n, 2n])).toThrow(RangeError);
  });

  it("always sums to the total and never deviates more than 1 from the exact share", () => {
    let seed = 42;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let round = 0; round < 500; round++) {
      const weights = Array.from({ length: 1 + (next() % 12) }, () => BigInt(next() % 100_000));
      if (sum(weights) === 0n) weights[0] = 1n;
      const total = BigInt(next() % 10_000_000) - 5_000_000n;
      const parts = allocate(total, weights);
      expect(sum(parts)).toBe(total);
      const weightSum = sum(weights);
      parts.forEach((part, i) => {
        const exactTimesSum = total * (weights[i] ?? 0n); // part ≈ exactTimesSum / weightSum
        const deviation = part * weightSum - exactTimesSum;
        expect(deviation < weightSum && deviation > -weightSum).toBe(true);
      });
    }
  });
});

describe("fromMajor", () => {
  it("converts whole tögrög", () => {
    expect(fromMajor(1500)).toBe(150_000n);
    expect(fromMajor(1500n)).toBe(150_000n);
  });

  it("refuses floats and unsafe integers", () => {
    expect(() => fromMajor(1.5)).toThrow(RangeError);
    expect(() => fromMajor(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats whole tögrög without decimals", () => {
    expect(formatMoney(1_234_500n)).toBe("12,345₮");
    expect(formatMoney(0n)).toBe("0₮");
  });

  it("shows möngö only when present (auto)", () => {
    expect(formatMoney(1_234_550n)).toBe("12,345.50₮");
    expect(formatMoney(9_091n)).toBe("90.91₮");
    expect(formatMoney(5n)).toBe("0.05₮");
  });

  it("supports always / never and no symbol", () => {
    expect(formatMoney(100n, { minor: "always" })).toBe("1.00₮");
    expect(formatMoney(9_050n, { minor: "never" })).toBe("91₮");
    expect(formatMoney(1_234_500n, { symbol: false })).toBe("12,345");
  });

  it("formats negatives and huge values exactly", () => {
    expect(formatMoney(-150_050n)).toBe("-1,500.50₮");
    expect(formatMoney(123_456_789_012_345_678_00n)).toBe("123,456,789,012,345,678₮");
  });

  it("uses the same grouping in English", () => {
    expect(formatMoney(1_234_550n, { locale: "en" })).toBe("12,345.50₮");
  });
});

describe("parseMoney", () => {
  it.each([
    ["12345", 1_234_500n],
    ["12,345", 1_234_500n],
    ["12 345", 1_234_500n],
    ["1,234,567", 123_456_700n],
    ["12345.5", 1_234_550n],
    ["12,345.50", 1_234_550n],
    ["₮12,345", 1_234_500n],
    ["12,345₮", 1_234_500n],
    ["  0.05 ", 5n],
    ["0", 0n],
  ])("parses %j", (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "12.345",
    "1,23",
    "12,3456",
    "1.2.3",
    "12.",
    ".5",
    "1e3",
    "--1",
    "12,345.5.0",
  ])("rejects %j", (input) => {
    expect(parseMoney(input)).toBeNull();
  });

  it("rejects negatives unless allowed", () => {
    expect(parseMoney("-100")).toBeNull();
    expect(parseMoney("-100", { allowNegative: true })).toBe(-10_000n);
  });

  it("round-trips with formatMoney", () => {
    for (const value of [0n, 5n, 9_091n, 1_234_550n, 999_999_999n]) {
      expect(parseMoney(formatMoney(value))).toBe(value);
    }
  });
});
