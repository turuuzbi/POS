import { describe, expect, it } from "vitest";
import { toWire } from "./checkout-contract";
import {
  SHIFT_ERROR_CODES,
  SHIFT_ERROR_MESSAGE_KEYS,
  cashMovementApprovalScope,
  cashMovementFingerprint,
  cashMovementInputSchema,
  cashMovementResultSchema,
  closeShiftInputSchema,
  closeShiftResultSchema,
  isCashMovementApprovalScope,
  isSameCashMovement,
  openShiftInputSchema,
  shiftApprovalKeys,
  shiftErrorFromIssues,
} from "./shift-contract";
import { validateCashMovement, validateCloseShift } from "./shift";

const ID = "01900000-0000-7000-8000-000000000001";
const SHIFT = "01900000-0000-7000-8000-0000000000aa";

const movement = (extra: Record<string, unknown> = {}) => ({
  movementId: ID,
  type: "CASH_OUT",
  amount: "500000",
  reason: "Supplier COD",
  createdAtClient: "2026-10-15T10:00:00Z",
  ...extra,
});

describe("shift inputs", () => {
  it("parses open / close / movement", () => {
    expect(openShiftInputSchema.parse({ openingFloat: "5000000" }).openingFloat).toBe(5_000_000n);
    const close = closeShiftInputSchema.parse({
      shiftId: SHIFT,
      denominations: { "20000": 3 },
      note: "  ok ",
    });
    expect(close.note).toBe("ok");
    const m = cashMovementInputSchema.parse(movement());
    expect(m.amount).toBe(500_000n);
    expect(m.approvals).toEqual({});
  });
  it.each([
    ["zero amount", { amount: "0" }],
    ["negative", { amount: "-1" }],
    ["empty reason", { reason: "   " }],
    ["bad type", { type: "CASH_SWAP" }],
    ["non-v7 id", { movementId: "550e8400-e29b-41d4-a716-446655440000" }],
  ])("rejects a movement with %s", (_n, extra) => {
    expect(cashMovementInputSchema.safeParse(movement(extra)).success).toBe(false);
  });
  it("rejects negative or fractional denomination counts at the schema", () => {
    expect(
      closeShiftInputSchema.safeParse({ shiftId: SHIFT, denominations: { "1000": -1 } }).success,
    ).toBe(false);
    expect(
      closeShiftInputSchema.safeParse({ shiftId: SHIFT, denominations: { "1000": 1.5 } }).success,
    ).toBe(false);
  });
});

describe("errors", () => {
  it("has a message key per code, including the documented ones", () => {
    for (const c of SHIFT_ERROR_CODES)
      expect(SHIFT_ERROR_MESSAGE_KEYS[c]).toBe(`shift.errors.${c}`);
    expect(SHIFT_ERROR_CODES).toContain("SHIFT_NOT_OPEN");
    expect(SHIFT_ERROR_CODES).toContain("VARIANCE_NOTE_REQUIRED");
  });
  it("maps domain issues", () => {
    const close = validateCloseShift({
      status: "OPEN",
      expectedCash: 10_000_000n,
      denominations: {},
    });
    expect(close.ok).toBe(false);
    if (!close.ok) expect(shiftErrorFromIssues(close.issues).code).toBe("VARIANCE_NOTE_REQUIRED");
    const mv = validateCashMovement({
      shiftStatus: "OPEN",
      type: "CASH_OUT",
      amount: 5000n,
      reason: "x",
      expectedCashOnHand: 100n,
    });
    expect(mv.ok).toBe(false);
    if (!mv.ok)
      expect(shiftErrorFromIssues(mv.issues)).toMatchObject({
        code: "PAYOUT_EXCEEDS_CASH",
        messageKey: "shift.errors.PAYOUT_EXCEEDS_CASH",
      });
  });
});

describe("fingerprint and approvals", () => {
  it("ignores approvals and the clock only", () => {
    const a = cashMovementInputSchema.parse(movement());
    const b = cashMovementInputSchema.parse(
      movement({ approvals: { "cash:overdraw": "t" }, createdAtClient: "2027-01-01T00:00:00Z" }),
    );
    expect(cashMovementFingerprint(a)).toBe(cashMovementFingerprint(b));
    expect(isSameCashMovement(cashMovementFingerprint(a), b)).toBe(true);
    for (const v of [{ amount: "500001" }, { reason: "other" }, { type: "CASH_IN" }]) {
      expect(cashMovementFingerprint(cashMovementInputSchema.parse(movement(v)))).not.toBe(
        cashMovementFingerprint(a),
      );
    }
  });
  it("scope is bound to id, type and amount", () => {
    const s = cashMovementApprovalScope(ID, shiftApprovalKeys.overdraw, {
      type: "CASH_OUT",
      amount: 500_000n,
    });
    expect(s).toBe(`${ID}:cash:overdraw:CASH_OUT:500000`);
    expect(isCashMovementApprovalScope(s)).toBe(true);
    expect(
      cashMovementApprovalScope(ID, shiftApprovalKeys.overdraw, {
        type: "CASH_OUT",
        amount: 500_001n,
      }),
    ).not.toBe(s);
    expect(isCashMovementApprovalScope(ID)).toBe(false);
    expect(s.length).toBeLessThanOrEqual(200);
  });
});

describe("results", () => {
  it("round-trip", () => {
    const close = {
      shiftId: SHIFT,
      zReportNumber: 4,
      expectedCash: 6_000_000n,
      countedCash: 5_950_000n,
      cashVariance: -50_000n,
      classification: "SHORT" as const,
    };
    expect(closeShiftResultSchema.parse(JSON.parse(JSON.stringify(toWire(close))))).toEqual(close);
    const mv = {
      movementId: ID,
      type: "CASH_IN" as const,
      amount: 100n,
      expectedCashAfter: 5_000_100n,
      replayed: false,
    };
    expect(cashMovementResultSchema.parse(JSON.parse(JSON.stringify(toWire(mv))))).toEqual(mv);
    // A blind caller (no reports.view) gets no drawer total.
    const blind = { ...mv, expectedCashAfter: null };
    expect(cashMovementResultSchema.parse(JSON.parse(JSON.stringify(toWire(blind))))).toEqual(
      blind,
    );
  });
});

describe("strict inputs and opening float", () => {
  it("rejects unknown keys and sub-note floats", () => {
    expect(openShiftInputSchema.safeParse({ openingFloat: "1000", registerId: "x" }).success).toBe(
      false,
    );
    expect(openShiftInputSchema.safeParse({ openingFloat: "1" }).success).toBe(false);
    expect(openShiftInputSchema.safeParse({ openingFloat: "1000" }).success).toBe(true);
  });
});
