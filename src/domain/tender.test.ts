import { describe, expect, it } from "vitest";
import { fromMajor } from "./money";
import {
  MAX_TENDERS,
  cashTenderFor,
  computeChange,
  quickCashAmounts,
  remainingBalance,
  validateTenders,
  type Tender,
} from "./tender";

const T = fromMajor; // ₮ → möngö

describe("validateTenders", () => {
  it("exact cash", () => {
    const r = validateTenders(T(5000), [{ method: "CASH", amount: T(5000) }]);
    expect(r).toMatchObject({ ok: true, totalApplied: T(5000), totalChange: 0n });
  });

  it("cash with change", () => {
    const r = validateTenders(T(37_500), [
      { method: "CASH", amount: T(37_500), tendered: T(40_000) },
    ]);
    expect(r).toMatchObject({ ok: true, totalChange: T(2500) });
    if (r.ok) expect(r.applied[0]).toMatchObject({ tendered: T(40_000), change: T(2500) });
  });

  it("split cash + card", () => {
    const r = validateTenders(T(30_000), [
      { method: "CASH", amount: T(10_000), tendered: T(10_000) },
      { method: "CARD", amount: T(20_000), reference: "RRN123" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("non-cash cannot exceed the remaining balance", () => {
    const r = validateTenders(T(10_000), [
      { method: "CASH", amount: T(4000) },
      { method: "CARD", amount: T(7000) },
    ]);
    expect(r).toEqual({ ok: false, issues: [{ code: "NON_CASH_EXCEEDS_BALANCE", index: 1 }] });
  });

  it("applied cash cannot exceed the balance either (change goes in tendered)", () => {
    const r = validateTenders(T(1000), [{ method: "CASH", amount: T(2000), tendered: T(2000) }]);
    expect(r).toEqual({ ok: false, issues: [{ code: "OVERPAID", index: 0 }] });
  });

  it("change only from cash", () => {
    const r = validateTenders(T(1000), [{ method: "CARD", amount: T(1000), tendered: T(2000) }]);
    expect(r).toEqual({ ok: false, issues: [{ code: "TENDERED_NOT_CASH", index: 0 }] });
  });

  it("underpaid and empty", () => {
    expect(validateTenders(T(1000), [{ method: "CASH", amount: T(500) }])).toEqual({
      ok: false,
      issues: [{ code: "UNDERPAID" }],
    });
    expect(validateTenders(T(1000), [])).toEqual({ ok: false, issues: [{ code: "UNDERPAID" }] });
    expect(validateTenders(0n, [])).toMatchObject({ ok: true, totalApplied: 0n });
  });

  it("rejects zero / negative amounts", () => {
    for (const amount of [0n, -100n]) {
      const r = validateTenders(T(1000), [
        { method: "CASH", amount },
        { method: "CARD", amount: T(1000) },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues).toContainEqual({ code: "NON_POSITIVE_AMOUNT", index: 0 });
    }
  });

  it("tendered below amount", () => {
    const r = validateTenders(T(1000), [{ method: "CASH", amount: T(1000), tendered: T(500) }]);
    expect(r).toEqual({ ok: false, issues: [{ code: "TENDERED_LESS_THAN_AMOUNT", index: 0 }] });
  });

  it("limits the number of tenders", () => {
    const tenders: Tender[] = Array.from({ length: MAX_TENDERS + 1 }, () => ({
      method: "CARD",
      amount: 100n,
    }));
    const r = validateTenders(BigInt(tenders.length) * 100n, tenders);
    expect(r).toEqual({ ok: false, issues: [{ code: "TOO_MANY_TENDERS" }] });
  });

  it("cash must be in cash units (5₮ rounding)", () => {
    const opts = { cashUnit: T(5) };
    expect(validateTenders(T(1005), [{ method: "CASH", amount: T(1005) }], opts).ok).toBe(true);
    const bad = validateTenders(T(1003), [{ method: "CASH", amount: T(1003) }], opts);
    expect(bad).toEqual({ ok: false, issues: [{ code: "CASH_NOT_IN_UNITS", index: 0 }] });
    // card is not constrained by cash coins
    expect(validateTenders(T(1003), [{ method: "CARD", amount: T(1003) }], opts).ok).toBe(true);
  });

  it("seeded property: valid ⇒ Σ applied = payable and change = Σ(tendered−amount)", () => {
    let seed = 5;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const methods = ["CASH", "CARD", "QPAY", "BANK_TRANSFER", "GIFT_CARD", "STORE_CREDIT"] as const;
    for (let i = 0; i < 2000; i++) {
      const payable = BigInt(next() % 5_000) * 100n;
      let left = payable;
      const tenders: Tender[] = [];
      while (left > 0n && tenders.length < 5) {
        const part =
          tenders.length === 4 || next() % 3 === 0
            ? left
            : BigInt(1 + (next() % Number(left / 100n))) * 100n;
        const method = methods[next() % methods.length]!;
        tenders.push(
          method === "CASH" && next() % 2 === 0
            ? { method, amount: part, tendered: part + BigInt(next() % 500) * 100n }
            : { method, amount: part },
        );
        left -= part;
      }
      const r = validateTenders(payable, tenders);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.applied.reduce((a, t) => a + t.amount, 0n)).toBe(payable);
        expect(r.totalChange).toBe(
          r.applied.reduce((a, t) => a + (t.tendered === null ? 0n : t.tendered - t.amount), 0n),
        );
      }
    }
  });
});

describe("helpers", () => {
  it("computeChange", () => {
    expect(computeChange(T(37_500), T(50_000))).toBe(T(12_500));
    expect(() => computeChange(T(10), T(5))).toThrow(RangeError);
  });

  it("remainingBalance is signed", () => {
    expect(remainingBalance(T(100), [{ amount: T(30) }])).toBe(T(70));
    expect(remainingBalance(T(100), [{ amount: T(130) }])).toBe(-T(30));
  });

  it("cashTenderFor applies at most the remaining balance", () => {
    expect(cashTenderFor(T(300), T(500))).toEqual({
      method: "CASH",
      amount: T(300),
      tendered: T(500),
    });
    expect(cashTenderFor(T(300), T(100))).toEqual({
      method: "CASH",
      amount: T(100),
      tendered: T(100),
    });
    expect(() => cashTenderFor(0n, T(1))).toThrow(RangeError);
  });

  it("quickCashAmounts: exact then rounded-up notes, deduped, ascending", () => {
    expect(quickCashAmounts(T(37_500))).toEqual([T(37_500), T(38_000), T(40_000)]);
    expect(quickCashAmounts(T(4200))).toEqual([T(4200), T(5000), T(10_000), T(20_000)]);
    expect(quickCashAmounts(T(20_000))).toEqual([T(20_000)]);
    expect(quickCashAmounts(T(20_001))).toEqual([
      T(20_001),
      T(21_000),
      T(25_000),
      T(30_000),
      T(40_000),
    ]);
    expect(quickCashAmounts(0n)).toEqual([]);
  });
});
