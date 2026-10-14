import { describe, expect, it } from "vitest";
import { computeLineTax, effectiveVatBps, type TaxRule } from "./tax";

const std = (over: Partial<TaxRule> = {}): TaxRule => ({
  treatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
  pricesIncludeTax: true,
  ...over,
});

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("computeLineTax inclusive", () => {
  it("splits 11 000₮ into 10 000 net + 1 000 VAT", () => {
    expect(computeLineTax(1_100_000n, std())).toEqual({
      net: 1_000_000n,
      vat: 100_000n,
      cityTax: 0n,
      gross: 1_100_000n,
    });
  });

  it("includes city tax in the divisor", () => {
    // 11% total on net: gross 11 100 → net 10 000, vat 1 000, city 100
    const t = computeLineTax(1_110_000n, std({ cityTaxRateBps: 100 }));
    expect(t).toEqual({ net: 1_000_000n, vat: 100_000n, cityTax: 10_000n, gross: 1_110_000n });
  });

  it("rounds half away from zero", () => {
    // 5 möngö × 1000 / 11000 = 0.4545 → 0 ; 6 → 0.545 → 1
    expect(computeLineTax(5n, std()).vat).toBe(0n);
    expect(computeLineTax(6n, std()).vat).toBe(1n);
  });
});

describe("computeLineTax exclusive", () => {
  it("adds VAT and city tax on top of net", () => {
    const t = computeLineTax(1_000_000n, std({ pricesIncludeTax: false, cityTaxRateBps: 200 }));
    expect(t).toEqual({ net: 1_000_000n, vat: 100_000n, cityTax: 20_000n, gross: 1_120_000n });
  });
});

describe("treatments", () => {
  it("ZERO_RATED and EXEMPT carry no VAT", () => {
    for (const treatment of ["ZERO_RATED", "EXEMPT"] as const) {
      const t = computeLineTax(123_456n, std({ treatment }));
      expect(t.vat).toBe(0n);
      expect(t.net).toBe(123_456n);
      expect(effectiveVatBps({ treatment, vatRateBps: 1000 })).toBe(0);
    }
  });

  it("city tax still applies to a zero-rated class", () => {
    const t = computeLineTax(1_010_000n, std({ treatment: "ZERO_RATED", cityTaxRateBps: 100 }));
    expect(t).toEqual({ net: 1_000_000n, vat: 0n, cityTax: 10_000n, gross: 1_010_000n });
  });
});

describe("validation", () => {
  it("rejects negative amounts and bad rates", () => {
    expect(() => computeLineTax(-1n, std())).toThrow(RangeError);
    expect(() => computeLineTax(1n, std({ vatRateBps: 1.5 }))).toThrow(RangeError);
    expect(() => computeLineTax(1n, std({ cityTaxRateBps: -1 }))).toThrow(RangeError);
    expect(() => computeLineTax(1n, std({ vatRateBps: 10_001 }))).toThrow(RangeError);
  });

  it("zero amount gives zeros", () => {
    expect(computeLineTax(0n, std())).toEqual({ net: 0n, vat: 0n, cityTax: 0n, gross: 0n });
  });
});

describe("properties (seeded)", () => {
  it("net + vat + city = gross, nothing negative, vat within a möngö of exact", () => {
    const next = rng(2026);
    const treatments = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;
    for (let i = 0; i < 5000; i++) {
      const amount = BigInt(Math.floor(next() ** 3 * 1e9));
      const rule: TaxRule = {
        treatment: treatments[Math.floor(next() * 3)]!,
        vatRateBps: Math.floor(next() * 3000),
        cityTaxRateBps: Math.floor(next() * 400),
        pricesIncludeTax: next() < 0.5,
      };
      const t = computeLineTax(amount, rule);
      expect(t.net + t.vat + t.cityTax).toBe(t.gross);
      expect(t.net >= 0n && t.vat >= 0n && t.cityTax >= 0n).toBe(true);
      if (rule.pricesIncludeTax) expect(t.gross).toBe(amount);
      else expect(t.net).toBe(amount);
    }
  });

  it("tiny amounts with extreme rates never go negative", () => {
    for (let amount = 0n; amount < 50n; amount++) {
      for (const [vatRateBps, cityTaxRateBps] of [
        [10_000, 0],
        [5000, 5000],
        [10_000, 10_000],
        [0, 10_000],
      ] as const) {
        const t = computeLineTax(amount, std({ vatRateBps, cityTaxRateBps }));
        expect(t.net).toBeGreaterThanOrEqual(0n);
        expect(t.net + t.vat + t.cityTax).toBe(amount);
      }
    }
  });
});
