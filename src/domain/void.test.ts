import { describe, expect, it } from "vitest";
import { fromMajor } from "./money";
import { planVoid, type VoidContext, type VoidSaleSnapshot } from "./void";

const T = fromMajor;

const sale = (extra: Partial<VoidSaleSnapshot> = {}): VoidSaleSnapshot => ({
  id: "sale",
  status: "COMPLETED",
  shiftId: "shift-1",
  totalAmount: T(30_000),
  lines: [
    { id: "a", variantId: "va", qtyMilli: 2000, unitCost: T(3000) },
    { id: "w", variantId: "vw", qtyMilli: 1250, unitCost: T(2000) },
    { id: "s", variantId: "vs", qtyMilli: 1000, unitCost: 0n, tracksStock: false },
  ],
  payments: [
    { id: "p1", method: "CASH", amount: T(10_000) },
    { id: "p2", method: "CARD", amount: T(20_000) },
  ],
  refundCount: 0,
  ...extra,
});

const ctx = (extra: Partial<VoidContext> = {}): VoidContext => ({
  shift: { id: "shift-1", status: "OPEN" },
  reason: "ENTRY_ERROR",
  grants: { void: true },
  ...extra,
});

const codes = (r: ReturnType<typeof planVoid>) => (r.ok ? [] : r.issues.map((i) => i.code));

describe("planVoid", () => {
  it("plans the reversal of payments and stock", () => {
    const r = planVoid(sale({ fiscalIssued: true }), ctx({ note: "  typo " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.note).toBe("typo");
    expect(r.plan.paymentReversals).toEqual([
      { paymentId: "p1", method: "CASH", amount: T(10_000), kind: "CASH_RETURN" },
      { paymentId: "p2", method: "CARD", amount: T(20_000), kind: "CARD_REVERSAL" },
    ]);
    expect(r.plan.cashReturned).toBe(T(10_000));
    expect(r.plan.stockRestores.map((s) => s.saleLineId)).toEqual(["a", "w"]);
    expect(r.plan.cogsReversalTotal).toBe(T(6000) + T(2500));
    expect(r.plan.fiscalReturn).toBe(true);
  });

  it("only from the same open shift", () => {
    expect(codes(planVoid(sale(), ctx({ shift: { id: "shift-2", status: "OPEN" } })))).toEqual([
      "SALE_IN_OTHER_SHIFT",
    ]);
    expect(codes(planVoid(sale(), ctx({ shift: { id: "shift-1", status: "CLOSED" } })))).toEqual([
      "SHIFT_NOT_OPEN",
    ]);
  });

  it("only completed sales without refunds", () => {
    expect(codes(planVoid(sale({ status: "VOIDED" }), ctx()))).toEqual(["SALE_NOT_COMPLETED"]);
    expect(codes(planVoid(sale({ refundCount: 1 }), ctx()))).toEqual(["HAS_REFUNDS"]);
  });

  it("reason OTHER needs a note", () => {
    expect(codes(planVoid(sale(), ctx({ reason: "OTHER" })))).toEqual(["REASON_NOTE_REQUIRED"]);
    expect(codes(planVoid(sale(), ctx({ reason: "OTHER", note: "  " })))).toEqual([
      "REASON_NOTE_REQUIRED",
    ]);
    expect(planVoid(sale(), ctx({ reason: "OTHER", note: "why" })).ok).toBe(true);
    expect(codes(planVoid(sale(), ctx({ note: "x".repeat(501) })))).toEqual(["NOTE_TOO_LONG"]);
  });

  it("needs the permission or an approval", () => {
    expect(codes(planVoid(sale(), ctx({ grants: { void: false } })))).toEqual([
      "APPROVAL_REQUIRED",
    ]);
  });

  it("gift card / exchange credit are not supported yet", () => {
    const r = planVoid(
      sale({ payments: [{ id: "g", method: "GIFT_CARD", amount: T(30_000) }] }),
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, issues: [{ code: "NOT_SUPPORTED" }] });
    expect(
      codes(
        planVoid(sale({ payments: [{ id: "g", method: "EXCHANGE_CREDIT", amount: 1n }] }), ctx()),
      ),
    ).toEqual(["NOT_SUPPORTED"]);
  });

  it("reports several problems at once", () => {
    expect(
      codes(planVoid(sale({ refundCount: 2, status: "VOIDED" }), ctx({ reason: "OTHER" }))),
    ).toEqual(["SALE_NOT_COMPLETED", "HAS_REFUNDS", "REASON_NOTE_REQUIRED"]);
  });
});
