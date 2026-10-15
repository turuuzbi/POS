import { describe, expect, it } from "vitest";
import { fromMajor } from "./money";
import {
  MAX_DENOMINATION_COUNT,
  MNT_DENOMINATIONS,
  VARIANCE_NOTE_THRESHOLD,
  cashVariance,
  classifyVariance,
  denominationsTotal,
  expectedCash,
  parseDenominations,
  sumCashMovements,
  validateCashMovement,
  validateCloseShift,
} from "./shift";

const T = fromMajor;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("expectedCash", () => {
  it("follows the schema comment", () => {
    expect(
      expectedCash({
        openingFloat: T(50_000),
        cashSales: T(120_000),
        cashRefunds: T(10_000),
        cashIn: T(5000),
        cashOut: T(20_000),
      }),
    ).toBe(T(145_000));
  });
  it("rejects negative components", () => {
    expect(() =>
      expectedCash({ openingFloat: 0n, cashSales: -1n, cashRefunds: 0n, cashIn: 0n, cashOut: 0n }),
    ).toThrow(RangeError);
  });
  it("seeded: linear in every component", () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const c = {
        openingFloat: BigInt(Math.floor(r() * 1e7)),
        cashSales: BigInt(Math.floor(r() * 1e8)),
        cashRefunds: BigInt(Math.floor(r() * 1e6)),
        cashIn: BigInt(Math.floor(r() * 1e6)),
        cashOut: BigInt(Math.floor(r() * 1e6)),
      };
      const base = expectedCash(c);
      expect(expectedCash({ ...c, cashSales: c.cashSales + 100n })).toBe(base + 100n);
      expect(expectedCash({ ...c, cashRefunds: c.cashRefunds + 100n })).toBe(base - 100n);
      expect(expectedCash({ ...c, cashOut: c.cashOut + 7n })).toBe(base - 7n);
      expect(expectedCash({ ...c, cashIn: c.cashIn + 7n })).toBe(base + 7n);
    }
  });
});

describe("denominations", () => {
  it("lists the MNT notes and coins once", () => {
    expect([...MNT_DENOMINATIONS]).toEqual([20000, 10000, 5000, 1000, 500, 100, 50, 20, 10]);
  });
  it("totals notes in möngö", () => {
    const r = parseDenominations({ "20000": 3, "1000": 12, "10": 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.total).toBe(T(60_000 + 12_000 + 50));
      expect(Object.keys(r.counts)).toHaveLength(MNT_DENOMINATIONS.length);
    }
  });
  it("accepts all zeros", () => {
    const r = parseDenominations({});
    expect(r).toMatchObject({ ok: true, total: 0n });
  });
  it.each([
    [null, "NOT_AN_OBJECT"],
    [[], "NOT_AN_OBJECT"],
    ["x", "NOT_AN_OBJECT"],
    [{ "3": 1 }, "UNKNOWN_DENOMINATION"],
    [{ "1000": -1 }, "INVALID_COUNT"],
    [{ "1000": 1.5 }, "INVALID_COUNT"],
    [{ "1000": "2" }, "INVALID_COUNT"],
    [{ "1000": Number.NaN }, "INVALID_COUNT"],
    [{ "1000": MAX_DENOMINATION_COUNT + 1 }, "COUNT_TOO_LARGE"],
  ])("rejects %j", (input, code) => {
    const r = parseDenominations(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe(code);
  });
  it("seeded: parse total equals independent sum", () => {
    const r = rng(5);
    for (let i = 0; i < 200; i++) {
      const input: Record<string, number> = {};
      let expected = 0n;
      for (const d of MNT_DENOMINATIONS) {
        const n = Math.floor(r() * 50);
        input[String(d)] = n;
        expected += BigInt(d) * 100n * BigInt(n);
      }
      const parsed = parseDenominations(input);
      expect(parsed.ok && parsed.total).toBe(expected);
      expect(denominationsTotal(input)).toBe(expected);
    }
  });
});

describe("variance", () => {
  it("is counted − expected", () => {
    expect(cashVariance(T(900), T(1000))).toBe(T(-100));
  });
  it("classifies", () => {
    expect(classifyVariance(0n)).toBe("OK");
    expect(classifyVariance(-1n)).toBe("SHORT");
    expect(classifyVariance(1n)).toBe("OVER");
    expect(classifyVariance(-100n, 100n)).toBe("OK");
    expect(classifyVariance(101n, 100n)).toBe("OVER");
    expect(() => classifyVariance(0n, -1n)).toThrow(RangeError);
  });
});

describe("validateCloseShift", () => {
  const base = { status: "OPEN" as const, expectedCash: T(50_000) };

  it("closes exactly", () => {
    const r = validateCloseShift({ ...base, denominations: { "20000": 2, "10000": 1 } });
    expect(r).toMatchObject({
      ok: true,
      countedCash: T(50_000),
      cashVariance: 0n,
      classification: "OK",
    });
  });
  it("small variance needs no note", () => {
    const r = validateCloseShift({ ...base, denominations: { "20000": 2, "10000": 1, "500": 1 } });
    expect(r).toMatchObject({ ok: true, cashVariance: T(500), classification: "OVER" });
  });
  it("variance at the threshold needs no note, above it does", () => {
    const at = validateCloseShift({ ...base, denominations: { "20000": 2, "5000": 1, "1000": 4 } });
    expect(at).toMatchObject({ ok: true, cashVariance: -VARIANCE_NOTE_THRESHOLD });
    const above = validateCloseShift({ ...base, denominations: { "20000": 2, "5000": 1 } });
    expect(above).toEqual({ ok: false, issues: [{ code: "VARIANCE_NOTE_REQUIRED" }] });
  });
  it("accepts a note and trims it", () => {
    const r = validateCloseShift({
      ...base,
      denominations: { "20000": 1 },
      note: "  gave change wrongly  ",
    });
    expect(r).toMatchObject({ ok: true, note: "gave change wrongly", classification: "SHORT" });
  });
  it("whitespace-only note does not satisfy the requirement", () => {
    const r = validateCloseShift({ ...base, denominations: {}, note: "   " });
    expect(r.ok).toBe(false);
  });
  it("custom threshold", () => {
    const r = validateCloseShift({
      ...base,
      denominations: { "20000": 2, "10000": 1, "500": 1 },
      noteThreshold: 0n,
    });
    expect(r).toEqual({ ok: false, issues: [{ code: "VARIANCE_NOTE_REQUIRED" }] });
  });
  it("must be open and have a valid count", () => {
    const closed = validateCloseShift({ ...base, status: "CLOSED", denominations: { "20000": 2 } });
    expect(closed.ok === false && closed.issues.map((i) => i.code)).toContain("SHIFT_NOT_OPEN");
    const bad = validateCloseShift({ ...base, denominations: undefined });
    expect(bad.ok === false && bad.issues[0]?.code).toBe("DENOMINATIONS_INVALID");
    const neg = validateCloseShift({ ...base, denominations: { "1000": -3 } });
    expect(neg.ok).toBe(false);
  });
  it("rejects a very long note", () => {
    const r = validateCloseShift({ ...base, denominations: {}, note: "x".repeat(501) });
    expect(r.ok === false && r.issues.map((i) => i.code)).toContain("NOTE_TOO_LONG");
  });
  it("seeded: variance always equals counted − expected and class matches sign", () => {
    const r = rng(77);
    for (let i = 0; i < 300; i++) {
      const input: Record<string, number> = {};
      for (const d of MNT_DENOMINATIONS) input[String(d)] = Math.floor(r() * 20);
      const expected = BigInt(Math.floor(r() * 3_000_000)) * 100n;
      const res = validateCloseShift({
        status: "OPEN",
        expectedCash: expected,
        denominations: input,
        note: "n",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.cashVariance).toBe(res.countedCash - expected);
        expect(res.classification).toBe(
          res.cashVariance === 0n ? "OK" : res.cashVariance < 0n ? "SHORT" : "OVER",
        );
      }
    }
  });
});

describe("validateCashMovement", () => {
  const ok = {
    shiftStatus: "OPEN" as const,
    type: "CASH_OUT" as const,
    amount: T(5000),
    reason: "Supplier COD",
    expectedCashOnHand: T(20_000),
  };
  it("accepts a normal payout and reports cash after", () => {
    expect(validateCashMovement(ok)).toMatchObject({ ok: true, expectedCashAfter: T(15_000) });
  });
  it("accepts a pay-in", () => {
    expect(validateCashMovement({ ...ok, type: "CASH_IN" })).toMatchObject({
      ok: true,
      expectedCashAfter: T(25_000),
    });
  });
  it("requires an open shift, positive amount and a reason", () => {
    const r = validateCashMovement({ ...ok, shiftStatus: "CLOSED", amount: 0n, reason: " " });
    expect(r.ok === false && r.issues.map((i) => i.code)).toEqual([
      "SHIFT_NOT_OPEN",
      "AMOUNT_NOT_POSITIVE",
      "REASON_REQUIRED",
    ]);
    expect(validateCashMovement({ ...ok, amount: -1n }).ok).toBe(false);
  });
  it("pay-out beyond the drawer needs approval; pay-in never does", () => {
    const over = validateCashMovement({ ...ok, amount: T(20_001) });
    expect(over).toMatchObject({ ok: false, needsOverdrawApproval: true });
    expect(validateCashMovement({ ...ok, amount: T(20_001), overdrawApproved: true }).ok).toBe(
      true,
    );
    expect(validateCashMovement({ ...ok, type: "CASH_IN", amount: T(10_000_000) }).ok).toBe(true);
    expect(validateCashMovement({ ...ok, amount: T(20_000) }).ok).toBe(true);
  });
  it("rejects absurd amounts and fractional coins", () => {
    const huge = validateCashMovement({ ...ok, type: "CASH_IN", amount: T(1_000_000_000) });
    expect(huge.ok === false && huge.issues[0]?.code).toBe("AMOUNT_TOO_LARGE");
    const frac = validateCashMovement({ ...ok, amount: 150n });
    expect(frac.ok === false && frac.issues[0]?.code).toBe("AMOUNT_NOT_IN_UNITS");
  });
  it("sums movements by direction", () => {
    expect(
      sumCashMovements([
        { type: "CASH_IN", amount: 5n },
        { type: "CASH_OUT", amount: 2n },
        { type: "CASH_IN", amount: 1n },
      ]),
    ).toEqual({ cashIn: 6n, cashOut: 2n });
  });
});
