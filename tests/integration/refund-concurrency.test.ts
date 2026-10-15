import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { refundSale, RefundFailure } from "@/server/services/refunds";
import { findLedgerMismatches } from "@/server/services/stock";
import { createStockedProduct, createTill } from "../support/checkout-fixtures";
import { db, resetDatabase } from "../support/db";
import { onHand, refundInputOf, sell, withTotal } from "../support/refund-fixtures";

const PARALLEL = 20;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("refund concurrency", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("20 parallel identical refunds write one refund and restock once", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 3000 }]);
    const ctx = till.ctx(till.manager);
    const input = await withTotal(
      refundInputOf(s.saleId, [{ saleLineId: s.lines[0]!.id, qtyMilli: 1000, restock: true }]),
      ctx,
    );
    const outcomes = await Promise.all(
      Array.from({ length: PARALLEL }, () => refundSale(input, ctx)),
    );
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.result.receiptNumber)).size).toBe(1);
    expect(await db.refund.count()).toBe(1);
    expect(await db.refundLine.count()).toBe(1);
    expect(await db.refundPayment.count()).toBe(1);
    expect(await db.stockMovement.count({ where: { type: "RETURN_RESTOCK" } })).toBe(1);
    expect(await onHand(till, variant.id)).toBe(100_000 - 3000 + 1000);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("20 parallel refunds of different lines all succeed and add up to the sale exactly", async () => {
    const till = await createTill();
    const products = [];
    for (let i = 0; i < PARALLEL; i++) {
      products.push(
        await createStockedProduct(till, { price: 12_300n + BigInt(i) * 700n, cost: 5_000n }),
      );
    }
    const s = await sell(
      till,
      products.map((p) => ({ variantId: p.variant.id, discountBps: 333 })),
    );
    expect(s.lines).toHaveLength(PARALLEL);
    const ctx = till.ctx(till.manager);
    const inputs = await Promise.all(
      s.lines.map((line) =>
        withTotal(
          refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 1000, restock: true }]),
          ctx,
        ),
      ),
    );
    // The quoted totals are all "not the last"; the one that completes the sale
    // returns what is left, so quote again would differ. Settle by retrying a
    // TOTAL_MISMATCH with the figure the server reports (a real client re-reads it).
    const settle = async (input: (typeof inputs)[number]) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await refundSale(input, ctx);
        } catch (error) {
          if (error instanceof RefundFailure && error.failure === "TOTAL_MISMATCH") {
            input = { ...input, expectedTotal: BigInt(String(error.details!.actual)) };
            continue;
          }
          throw error;
        }
      }
      throw new Error("did not settle");
    };
    const outcomes = await Promise.all(inputs.map(settle));
    expect(outcomes.every((o) => o.created)).toBe(true);
    expect(outcomes.filter((o) => o.result.completesSale)).toHaveLength(1);
    const refunds = await db.refund.findMany({ include: { lines: true, payments: true } });
    expect(refunds).toHaveLength(PARALLEL);
    expect(sum(refunds.map((r) => r.totalAmount))).toBe(s.sale.totalAmount);
    expect(sum(refunds.flatMap((r) => r.lines).map((l) => l.totalAmount))).toBe(s.sale.itemsAmount);
    expect(sum(refunds.flatMap((r) => r.payments).map((p) => p.amount))).toBe(s.sale.totalAmount);
    expect(new Set(refunds.map((r) => r.number)).size).toBe(PARALLEL);
    for (const p of products) expect(await onHand(till, p.variant.id)).toBe(100_000);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("20 parallel refunds of the same unit: one wins, the rest see it refunded", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
    const line = s.lines[0]!;
    const ctx = till.ctx(till.manager);
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () =>
        refundSale(
          refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 2000, restock: true }], {
            expectedTotal: "200000",
          }),
          ctx,
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const codes = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as RefundFailure).failure);
    expect(new Set(codes)).toEqual(new Set(["ALREADY_REFUNDED"]));
    expect(await db.refund.count()).toBe(1);
    expect(await onHand(till, variant.id)).toBe(100_000);
  });

  it("per-tender caps hold: refunds can never pay back more than each tender took", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }], () => [
      { method: "CASH", amount: "50000", tendered: "60000" },
      { method: "CARD", amount: "150000" },
    ]);
    const line = s.lines[0]!;
    const ctx = till.ctx(till.manager);
    // 20 different refund ids, each wants one unit; only two units exist.
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, async () => {
        const draft = refundInputOf(
          s.saleId,
          [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
          {
            expectedTotal: "100000",
          },
        );
        return refundSale(draft, ctx);
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(2); // two units exist, whatever the order
    const rows = await db.refundPayment.findMany();
    for (const payment of s.payments) {
      const paidBack = sum(
        rows.filter((r) => r.originalPaymentId === payment.id).map((r) => r.amount),
      );
      expect(paidBack).toBeLessThanOrEqual(payment.amount);
    }
    const refunds = await db.refund.findMany();
    expect(sum(refunds.map((r) => r.totalAmount))).toBe(s.sale.totalAmount);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });
});
