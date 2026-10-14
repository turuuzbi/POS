import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPROVAL_POLICY,
  allocateCartDiscount,
  applyCartDiscounts,
  applyDiscountsSequentially,
  discountNeedsApproval,
  isValidDiscountRequest,
  resolveDiscount,
  type DiscountRequest,
} from "./discounts";

const pct = (percentBps: number): DiscountRequest => ({ kind: "PERCENT", percentBps });
const fixed = (amount: bigint): DiscountRequest => ({ kind: "FIXED", amount });

describe("resolveDiscount", () => {
  it("percent in bps, half-up", () => {
    expect(resolveDiscount(1_000_00n, pct(1000))).toBe(100_00n);
    expect(resolveDiscount(5n, pct(1000))).toBe(1n); // 0.5 → 1
    expect(resolveDiscount(4n, pct(1000))).toBe(0n);
  });

  it("fixed is capped at the base", () => {
    expect(resolveDiscount(500n, fixed(900n))).toBe(500n);
    expect(resolveDiscount(500n, fixed(200n))).toBe(200n);
  });

  it("100% takes everything, never more", () => {
    expect(resolveDiscount(12_345n, pct(10_000))).toBe(12_345n);
  });

  it("rejects invalid requests", () => {
    expect(isValidDiscountRequest(pct(0))).toBe(false);
    expect(isValidDiscountRequest(pct(10_001))).toBe(false);
    expect(isValidDiscountRequest(pct(1.5))).toBe(false);
    expect(isValidDiscountRequest(fixed(0n))).toBe(false);
    expect(() => resolveDiscount(100n, pct(0))).toThrow(RangeError);
    expect(() => resolveDiscount(-1n, pct(100))).toThrow(RangeError);
  });
});

describe("applyDiscountsSequentially", () => {
  it("stacks multiplicatively in array order", () => {
    const r = applyDiscountsSequentially(1_000_00n, [pct(1000), pct(500)]);
    expect(r.total).toBe(145_00n); // 10% then 5% of the rest
    expect(r.remaining).toBe(855_00n);
    expect(r.steps.map((s) => s.base)).toEqual([1_000_00n, 900_00n]);
  });

  it("order matters with fixed amounts", () => {
    expect(applyDiscountsSequentially(100n, [fixed(50n), pct(5000)]).remaining).toBe(25n);
    expect(applyDiscountsSequentially(100n, [pct(5000), fixed(50n)]).remaining).toBe(0n);
  });

  it("never goes negative", () => {
    const r = applyDiscountsSequentially(100n, [fixed(80n), fixed(80n), pct(10_000)]);
    expect(r.remaining).toBe(0n);
    expect(r.total).toBe(100n);
  });
});

describe("cart discount allocation", () => {
  it("allocates pro-rata and sums exactly", () => {
    expect(allocateCartDiscount(100n, [100n, 100n, 100n])).toEqual([34n, 33n, 33n]);
    const parts = allocateCartDiscount(1000n, [333n, 333n, 334n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
  });

  it("caps at the pool and gives zero-value lines nothing", () => {
    expect(allocateCartDiscount(9999n, [100n, 0n, 50n])).toEqual([100n, 0n, 50n]);
    expect(allocateCartDiscount(0n, [])).toEqual([]);
  });

  it("applyCartDiscounts chains over the remaining amounts", () => {
    const r = applyCartDiscounts([600n, 400n], [pct(1000), fixed(100n)]);
    expect(r.steps.map((s) => s.amount)).toEqual([100n, 100n]);
    expect(r.total).toBe(200n);
    expect(r.perLine).toEqual([120n, 80n]);
  });

  it("seeded property: exact sum, no line over-discounted", () => {
    let seed = 99;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let i = 0; i < 2000; i++) {
      const lines = Array.from({ length: 1 + (next() % 8) }, () =>
        next() % 5 === 0 ? 0n : BigInt(next() % 500_000),
      );
      const requests: DiscountRequest[] = Array.from({ length: next() % 4 }, () =>
        next() % 2 === 0 ? pct(1 + (next() % 10_000)) : fixed(BigInt(1 + (next() % 800_000))),
      );
      const pool = lines.reduce((a, b) => a + b, 0n);
      const r = applyCartDiscounts(lines, requests);
      expect(r.total).toBe(r.steps.reduce((a, s) => a + s.amount, 0n));
      expect(r.total <= pool).toBe(true);
      expect(r.perLine.reduce((a, b) => a + b, 0n)).toBe(r.total);
      r.perLine.forEach((share, idx) => {
        expect(share >= 0n && share <= lines[idx]!).toBe(true);
      });
    }
  });
});

describe("discountNeedsApproval", () => {
  it("percent above threshold needs approval", () => {
    expect(discountNeedsApproval(pct(1000), 1000n)).toBe(false);
    expect(discountNeedsApproval(pct(1001), 1000n)).toBe(true);
  });

  it("fixed amounts use their effective rate", () => {
    expect(discountNeedsApproval(fixed(100n), 1000n)).toBe(false); // exactly 10%
    expect(discountNeedsApproval(fixed(101n), 1000n)).toBe(true);
    expect(discountNeedsApproval(fixed(5000n), 1000n)).toBe(true); // capped = 100%
    expect(discountNeedsApproval(fixed(5n), 0n)).toBe(false);
  });

  it("threshold is configurable", () => {
    expect(discountNeedsApproval(pct(500), 1000n, { maxDiscountBpsWithoutApproval: 0 })).toBe(true);
    expect(DEFAULT_APPROVAL_POLICY.maxDiscountBpsWithoutApproval).toBe(1000);
  });
});
