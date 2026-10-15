import { describe, expect, it } from "vitest";
import { voidInputSchema } from "@/domain/void-contract";
import { buildVoidInput, checkVoid, voidBlockForRow } from "./void";
import { IDS, makeSale } from "./test-fixtures";

describe("voidBlockForRow", () => {
  const row = (
    state: "OK" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOIDED",
    shiftId = IDS.shift,
  ) => ({
    state,
    shiftId,
  });

  it("explains why a sale cannot be voided, most fundamental reason first", () => {
    expect(voidBlockForRow(row("OK"), IDS.shift)).toBeNull();
    expect(voidBlockForRow(row("VOIDED"), IDS.shift)).toBe("SALE_NOT_COMPLETED");
    expect(voidBlockForRow(row("OK"), null)).toBe("SHIFT_NOT_OPEN");
    expect(voidBlockForRow(row("OK", IDS.otherShift), IDS.shift)).toBe("SALE_IN_OTHER_SHIFT");
    expect(voidBlockForRow(row("PARTIALLY_REFUNDED"), IDS.shift)).toBe("HAS_REFUNDS");
    expect(voidBlockForRow(row("REFUNDED"), IDS.shift)).toBe("HAS_REFUNDS");
  });
});

describe("checkVoid", () => {
  const sale = makeSale();

  it("is allowed in the open shift and tells how much cash goes back", () => {
    const check = checkVoid({
      sale,
      currentShiftId: IDS.shift,
      reason: "ENTRY_ERROR",
      note: "",
      role: "MANAGER",
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.needsApproval).toBe(false);
      expect(check.plan.cashReturned).toBe(850_200n);
      expect(check.plan.paymentReversals.map((p) => p.kind)).toEqual([
        "CARD_REVERSAL",
        "CASH_RETURN",
      ]);
      expect(check.scope).toBe(`${IDS.sale}:void:1850200`);
    }
  });

  it("makes a cashier ask a manager", () => {
    const check = checkVoid({
      sale,
      currentShiftId: IDS.shift,
      reason: "CUSTOMER_CANCELLED",
      note: "",
      role: "CASHIER",
    });
    expect(check.ok && check.needsApproval).toBe(true);
  });

  it("blocks other shifts, refunded sales and voided sales with the specific reason", () => {
    const other = checkVoid({
      sale,
      currentShiftId: IDS.otherShift,
      reason: "ENTRY_ERROR",
      note: "",
      role: "MANAGER",
    });
    expect(other).toMatchObject({ ok: false, blocks: ["SALE_IN_OTHER_SHIFT"] });
    const voided = checkVoid({
      sale: makeSale({ status: "VOIDED" }),
      currentShiftId: IDS.shift,
      reason: "ENTRY_ERROR",
      note: "",
      role: "MANAGER",
    });
    expect(voided).toMatchObject({ ok: false, blocks: ["SALE_NOT_COMPLETED"] });
    const noShift = checkVoid({
      sale,
      currentShiftId: null,
      reason: "ENTRY_ERROR",
      note: "",
      role: "MANAGER",
    });
    expect(noShift).toMatchObject({
      ok: false,
      blocks: expect.arrayContaining(["SHIFT_NOT_OPEN"]),
    });
  });

  it("a missing reason or note is pending, not a block", () => {
    const none = checkVoid({
      sale,
      currentShiftId: IDS.shift,
      reason: null,
      note: "",
      role: "MANAGER",
    });
    expect(none).toMatchObject({ ok: false, blocks: [], pending: true });
    // what the void would do is already known, so the screen can show it
    expect(none.ok === false && none.plan?.cashReturned).toBe(850_200n);
    const other = checkVoid({
      sale,
      currentShiftId: IDS.shift,
      reason: "OTHER",
      note: " ",
      role: "MANAGER",
    });
    expect(other).toMatchObject({ ok: false, blocks: [], pending: true });
  });

  it("flags tenders the void cannot reverse yet", () => {
    const giftCard = makeSale({
      payments: [
        {
          id: IDS.card,
          method: "GIFT_CARD",
          amount: 1_850_200n,
          change: 0n,
          reference: null,
          cardLast4: null,
        },
      ],
    });
    const check = checkVoid({
      sale: giftCard,
      currentShiftId: IDS.shift,
      reason: "ENTRY_ERROR",
      note: "",
      role: "MANAGER",
    });
    expect(check).toMatchObject({ ok: false, blocks: ["NOT_SUPPORTED"] });
  });
});

describe("buildVoidInput", () => {
  it("passes the server's schema, with the approval token under the void key", () => {
    const wire = buildVoidInput({
      saleId: IDS.sale,
      reason: "OTHER",
      note: " duplicate ",
      token: "tok",
      now: new Date("2026-10-15T10:00:00.000Z"),
    });
    const parsed = voidInputSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.approvals).toEqual({ void: "tok" });
      expect(parsed.data.note).toBe("duplicate");
    }
    expect(
      voidInputSchema.safeParse(
        buildVoidInput({ saleId: IDS.sale, reason: "ENTRY_ERROR", note: "", token: null }),
      ).success,
    ).toBe(true);
  });
});
