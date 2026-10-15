import { describe, expect, it } from "vitest";
import { planRefund, type PreviousRefund, type RefundSaleSnapshot } from "./refund";

describe("regression: exchange credit must not leave sub-coin cash residue", () => {
  it("the refund that completes the sale after an exchange can still be paid out", () => {
    const sale: RefundSaleSnapshot = {
      id: "s",
      status: "COMPLETED",
      occurredAt: new Date("2026-10-14T00:00:00Z"),
      shiftId: "s",
      totalAmount: 491700n,
      tipAmount: 4136n,
      roundingAmount: 41n,
      lines: [
        {
          id: "l0",
          variantId: "v0",
          unit: "KG",
          qtyMilli: 7844,
          totalAmount: 487523n,
          netAmount: 461253n,
          vatAmount: 23100n,
          cityTaxAmount: 3170n,
          unitCost: 42257n,
        },
      ],
      payments: [
        { id: "p0", method: "CARD", amount: 37071n },
        { id: "p1", method: "BANK_TRANSFER", amount: 35507n },
        { id: "p2", method: "CASH", amount: 386700n },
        { id: "p3", method: "QPAY", amount: 32422n },
      ],
    };
    const ctx = {
      shiftOpen: true,
      now: new Date("2026-10-15T00:00:00Z"),
      roundingUnit: 100n,
      grants: { refund: true, methodOverride: true, outsideWindow: true },
    };
    const first = planRefund(
      sale,
      [],
      {
        lines: [{ saleLineId: "l0", qtyMilli: 3706, restock: true }],
        reason: "CHANGED_MIND",
        exchangeSaleTotal: 230300n,
      },
      ctx,
    );
    if (!first.ok) throw new Error(JSON.stringify(first.issues));
    const prev: PreviousRefund = {
      id: "r0",
      totalAmount: first.plan.totalAmount,
      tipAmount: first.plan.tipAmount,
      lines: first.plan.lines.map((l) => ({
        saleLineId: l.saleLineId,
        qtyMilli: l.qtyMilli,
        netAmount: l.netAmount,
        vatAmount: l.vatAmount,
        cityTaxAmount: l.cityTaxAmount,
        totalAmount: l.totalAmount,
      })),
      payments: first.plan.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        originalPaymentId: p.originalPaymentId,
      })),
    };
    const rest = planRefund(
      sale,
      [prev],
      { lines: [{ saleLineId: "l0", qtyMilli: 4138, restock: true }], reason: "CHANGED_MIND" },
      ctx,
    );
    expect(rest.ok).toBe(true);
  });
});
