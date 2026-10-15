import { describe, expect, it } from "vitest";
import { toWire } from "@/domain/checkout-contract";
import { planRefund } from "@/domain/refund";
import { saleState } from "./plan";
import {
  recentSalesResultSchema,
  resultFromStored,
  returnLookupResultSchema,
  returnSaleWireSchema,
  toRefundSnapshot,
  toVoidSnapshot,
} from "./sale-wire";
import { IDS, makeSale } from "./test-fixtures";

describe("wire schemas", () => {
  it("parses what the server sends (bigint as strings) back into bigint", () => {
    const wire = toWire(makeSale());
    const parsed = returnSaleWireSchema.parse(wire);
    expect(parsed.totalAmount).toBe(1_850_200n);
    expect(parsed.lines[1]!.qtyMilli).toBe(1500);
    expect(parsed.payments[0]!.amount).toBe(1_000_000n);
  });

  it("parses the lookup envelope, including 'not found'", () => {
    const found = returnLookupResultSchema.parse(
      toWire({ sale: makeSale(), policy: { maxRefundWindowDays: 30 }, roundingUnit: 100n }),
    );
    expect(found.sale?.number).toBe("UB1-000123");
    expect(found.roundingUnit).toBe(100n);
    const none = returnLookupResultSchema.parse(
      toWire({ sale: null, policy: { maxRefundWindowDays: null }, roundingUnit: 100n }),
    );
    expect(none.sale).toBeNull();
  });

  it("parses recent sales rows", () => {
    const parsed = recentSalesResultSchema.parse(
      toWire({
        sales: [
          {
            id: IDS.sale,
            number: "UB1-000123",
            occurredAt: "2026-10-14T10:00:00.000Z",
            shiftId: IDS.shift,
            totalAmount: 1_850_200n,
            lineCount: 3,
            methods: ["CARD", "CASH"],
            state: "OK",
          },
        ],
        truncated: false,
      }),
    );
    expect(parsed.sales[0]!.totalAmount).toBe(1_850_200n);
  });

  it("never carries costs to the register", () => {
    expect(JSON.stringify(toWire(makeSale()))).not.toMatch(/unitCost|cost/i);
    expect(toRefundSnapshot(makeSale()).lines.every((l) => l.unitCost === 0n)).toBe(true);
    expect(toVoidSnapshot(makeSale()).lines.every((l) => l.unitCost === 0n)).toBe(true);
  });
});

describe("resultFromStored", () => {
  it("rebuilds the receipt of a refund the sale already holds", () => {
    const sale = makeSale();
    const plan = planRefund(
      toRefundSnapshot(sale),
      [],
      {
        reason: "DEFECTIVE",
        lines: [{ saleLineId: IDS.milk, qtyMilli: 1000, restock: true }],
      },
      {
        shiftOpen: true,
        now: new Date("2026-10-15T00:00:00Z"),
        roundingUnit: 100n,
        grants: { refund: true, methodOverride: true, outsideWindow: true },
      },
    );
    if (!plan.ok) throw new Error("plan failed");
    const withRefund = makeSale({
      refunds: [
        {
          id: IDS.newRefund,
          number: "UB1-R-000007",
          occurredAt: "2026-10-15T00:00:00.000Z",
          reason: "DEFECTIVE",
          totalAmount: plan.plan.totalAmount,
          tipAmount: plan.plan.tipAmount,
          lines: plan.plan.lines.map((l) => ({
            saleLineId: l.saleLineId,
            qtyMilli: l.qtyMilli,
            restock: l.restock,
            netAmount: l.netAmount,
            vatAmount: l.vatAmount,
            cityTaxAmount: l.cityTaxAmount,
            totalAmount: l.totalAmount,
          })),
          payments: plan.plan.payments.map((p) => ({
            method: p.method,
            amount: p.amount,
            originalPaymentId: p.originalPaymentId,
          })),
        },
      ],
    });
    const result = resultFromStored(withRefund, IDS.newRefund);
    expect(result).not.toBeNull();
    expect(result!.receiptNumber).toBe("UB1-R-000007");
    expect(result!.totals.totalAmount).toBe(plan.plan.totalAmount);
    expect(result!.totals.vatAmount).toBe(plan.plan.vatAmount);
    expect(result!.cashRefund).toBe(plan.plan.cashRefund);
    expect(result!.lines[0]).toMatchObject({ restock: true, qtyMilli: 1000 });
    expect(result!.completesSale).toBe(false);
    expect(result!.replayed).toBe(true);
    expect(saleState(withRefund)).toBe("PARTIALLY_REFUNDED");
    expect(resultFromStored(withRefund, IDS.refund)).toBeNull();
  });
});
