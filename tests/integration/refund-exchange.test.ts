import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckoutInputWire } from "@/domain/checkout-contract";
import { refundSale } from "@/server/services/refunds";
import { findLedgerMismatches } from "@/server/services/stock";
import {
  buildInput,
  createStockedProduct,
  createTill,
  lineOf,
  type Till,
} from "../support/checkout-fixtures";
import { db, resetDatabase } from "../support/db";
import {
  allLines,
  onHand,
  quotePayable,
  refundFailure,
  refundInputOf,
  refundOk,
  sell,
  uuidv7,
  withTotal,
} from "../support/refund-fixtures";

/** The replacement sale's checkout (tenders = net due only) and the refund's `exchange` link. */
async function exchangeFor(
  items: { variantId: string; qtyMilli?: number }[],
  tendersFor: (netDue: bigint) => CheckoutInputWire["tenders"],
  creditFor: bigint,
  override: { expectedPayable?: bigint; saleId?: string } = {},
) {
  const lines = items.map((i) => lineOf(i.variantId, i.qtyMilli ?? 1000));
  const payable = await quotePayable(lines);
  const netDue = payable > creditFor ? payable - creditFor : 0n;
  const saleId = override.saleId ?? uuidv7();
  const expectedPayable = override.expectedPayable ?? payable;
  const checkout = buildInput({
    saleId,
    lines,
    expectedPayable: expectedPayable.toString(),
    tenders: tendersFor(netDue),
  });
  return {
    payable,
    netDue,
    saleId,
    checkout,
    exchange: { saleId, expectedPayable: expectedPayable.toString() },
  };
}

async function doExchange(
  till: Till,
  returned: Awaited<ReturnType<typeof sell>>,
  xc: Awaited<ReturnType<typeof exchangeFor>>,
) {
  return refundOk(
    till,
    returned.saleId,
    allLines(returned.lines),
    { exchange: xc.exchange },
    till.manager,
    { exchangeCheckout: xc.checkout },
  );
}

describe("exchange", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("returns a 1 000 item for a 1 500 item: credit 1 000, net due 500 in cash", async () => {
    const till = await createTill();
    const cheap = await createStockedProduct(till, { price: 100_000n, cost: 30_000n });
    const dear = await createStockedProduct(till, { price: 150_000n, cost: 90_000n });
    const s = await sell(till, [{ variantId: cheap.variant.id }]);
    const xc = await exchangeFor(
      [{ variantId: dear.variant.id }],
      (due) => [{ method: "CASH", amount: due.toString(), tendered: "100000" }],
      100_000n,
    );
    const { result, input } = await doExchange(till, s, xc);

    expect(result.exchange).toEqual({
      saleId: xc.saleId,
      creditApplied: 100_000n,
      netDue: 50_000n,
      netRefund: 0n,
    });
    expect(result.cashRefund).toBe(0n);
    expect(result.payments).toEqual([
      expect.objectContaining({ method: "EXCHANGE_CREDIT", amount: 100_000n }),
    ]);

    const refund = await db.refund.findUniqueOrThrow({ where: { id: input.refundId } });
    expect(refund.exchangeSaleId).toBe(xc.saleId);
    const sale = await db.sale.findUniqueOrThrow({
      where: { id: xc.saleId },
      include: { payments: { orderBy: { id: "asc" } } },
    });
    expect(sale.totalAmount).toBe(150_000n);
    expect(sale.payments.map((p) => [p.method, p.amount, p.change])).toEqual([
      ["CASH", 50_000n, 50_000n],
      ["EXCHANGE_CREDIT", 100_000n, 0n],
    ]);
    expect(sale.payments[1]!.reference).toBe(input.refundId);
    expect(sale.shiftId).toBe(refund.shiftId);
    expect(await onHand(till, cheap.variant.id)).toBe(100_000);
    expect(await onHand(till, dear.variant.id)).toBe(100_000 - 1000);
    expect(await findLedgerMismatches(db)).toEqual([]);
    const row = await db.refundPayment.findFirstOrThrow({ where: { refundId: input.refundId } });
    expect(row.reference).toBe(xc.saleId);
  });

  it("returns a 1 000 item for a 600 item: credit 600, net refund 400 in cash", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till, { price: 100_000n });
    const b = await createStockedProduct(till, { price: 60_000n });
    const s = await sell(till, [{ variantId: a.variant.id }]);
    const xc = await exchangeFor([{ variantId: b.variant.id }], () => [], 60_000n);
    const { result } = await doExchange(till, s, xc);
    expect(result.exchange).toEqual({
      saleId: xc.saleId,
      creditApplied: 60_000n,
      netDue: 0n,
      netRefund: 40_000n,
    });
    expect(result.cashRefund).toBe(40_000n);
    const sum = result.payments.reduce((acc, p) => acc + p.amount, 0n);
    expect(sum).toBe(100_000n);
    const sale = await db.sale.findUniqueOrThrow({
      where: { id: xc.saleId },
      include: { payments: true },
    });
    expect(sale.payments.map((p) => p.method)).toEqual(["EXCHANGE_CREDIT"]);
  });

  it("replays an exchange without a second sale, and detects a different cart", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till, { price: 100_000n });
    const b = await createStockedProduct(till, { price: 120_000n });
    const c = await createStockedProduct(till, { price: 130_000n });
    const s = await sell(till, [{ variantId: a.variant.id }]);
    const xc = await exchangeFor(
      [{ variantId: b.variant.id }],
      (due) => [{ method: "CASH", amount: due.toString() }],
      100_000n,
    );
    const first = await doExchange(till, s, xc);
    const options = { exchangeCheckout: xc.checkout };
    const again = await refundSale(first.input, till.ctx(till.manager), options);
    expect(again.result.replayed).toBe(true);
    expect(again.result.exchange).toEqual(first.result.exchange);
    expect(await db.sale.count()).toBe(2);
    expect(await db.refund.count()).toBe(1);

    const other = await exchangeFor(
      [{ variantId: c.variant.id }],
      (due) => [{ method: "CASH", amount: due.toString() }],
      100_000n,
      { saleId: xc.saleId },
    );
    const conflict = await refundFailure(
      refundSale(
        { ...first.input, exchange: { saleId: xc.saleId, expectedPayable: other.payable } },
        till.ctx(till.manager),
        { exchangeCheckout: other.checkout },
      ),
    );
    expect(conflict.failure).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rolls the whole exchange back when the replacement sale cannot be completed", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till, { price: 100_000n });
    const b = await createStockedProduct(till, { price: 150_000n });
    const s = await sell(till, [{ variantId: a.variant.id }]);
    const before = {
      a: await onHand(till, a.variant.id),
      b: await onHand(till, b.variant.id),
    };

    // 1. The customer's tenders do not cover the net due.
    const under = await exchangeFor(
      [{ variantId: b.variant.id }],
      () => [{ method: "CASH", amount: "10000" }],
      100_000n,
    );
    const tender = await refundFailure(doExchange(till, s, under));
    expect(tender.failure).toBe("EXCHANGE_INVALID");
    expect(tender.details).toMatchObject({ checkout: "TENDER_UNDERPAID" });

    // 2. The replacement total the cashier saw is not what the server computes.
    const stale = await exchangeFor(
      [{ variantId: b.variant.id }],
      (due) => [{ method: "CASH", amount: due.toString() }],
      100_000n,
      { expectedPayable: 140_000n },
    );
    const mismatch = await refundFailure(doExchange(till, s, stale));
    expect(mismatch.failure).toBe("EXCHANGE_MISMATCH");

    // 3. The link and the checkout disagree.
    const good = await exchangeFor([{ variantId: b.variant.id }], () => [], 150_000n);
    const split = await refundFailure(
      refundSale(
        refundInputOf(s.saleId, allLines(s.lines), {
          exchange: { saleId: uuidv7(), expectedPayable: good.payable.toString() },
        }),
        till.ctx(till.manager),
        { exchangeCheckout: good.checkout },
      ),
    );
    expect(split.failure).toBe("EXCHANGE_MISMATCH");

    expect(await db.refund.count()).toBe(0);
    expect(await db.sale.count()).toBe(1);
    expect(await db.stockMovement.count({ where: { type: "RETURN_RESTOCK" } })).toBe(0);
    expect(await onHand(till, a.variant.id)).toBe(before.a);
    expect(await onHand(till, b.variant.id)).toBe(before.b);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("counts the returned goods before checking stock when negative stock is not allowed", async () => {
    const till = await createTill();
    await db.businessSettings.upsert({
      where: { id: 1 },
      update: { allowNegativeStock: false },
      create: { id: 1, businessName: "Test", allowNegativeStock: false },
    });
    const last = await createStockedProduct(till, { price: 100_000n, stockMilli: 1000 });
    const empty = await createStockedProduct(till, { price: 100_000n, stockMilli: 0 });
    const s = await sell(till, [{ variantId: last.variant.id }]);
    expect(await onHand(till, last.variant.id)).toBe(0);

    // Buying something that is not there fails (and nothing is refunded) ...
    const bad = await exchangeFor([{ variantId: empty.variant.id }], () => [], 100_000n);
    const failure = await refundFailure(doExchange(till, s, bad));
    expect(failure.failure).toBe("EXCHANGE_INVALID");
    expect(failure.details).toMatchObject({ checkout: "INSUFFICIENT_STOCK" });
    expect(await db.refund.count()).toBe(0);
    expect(await onHand(till, last.variant.id)).toBe(0);

    // ... but swapping the last piece for the same item works: the return is back on the shelf first.
    const same = await exchangeFor([{ variantId: last.variant.id }], () => [], 100_000n);
    await doExchange(till, s, same);
    expect(await onHand(till, last.variant.id)).toBe(0);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("refuses to reuse an existing sale id for the replacement", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till, { price: 100_000n });
    const s = await sell(till, [{ variantId: a.variant.id }]);
    const other = await sell(till, [{ variantId: a.variant.id }]);
    const xc = await exchangeFor([{ variantId: a.variant.id }], () => [], 100_000n, {
      saleId: other.saleId,
    });
    const failure = await refundFailure(doExchange(till, s, xc));
    expect(failure.failure).toBe("EXCHANGE_INVALID");
    expect(failure.details).toMatchObject({ reason: "EXCHANGE_SALE_EXISTS" });
    const draft = await withTotal(
      refundInputOf(s.saleId, allLines(s.lines)),
      till.ctx(till.manager),
    );
    expect(draft.expectedTotal).toBe(100_000n);
  });

  it("an exchange refund on a card sale keeps the card capacity: credit consumes value, payout goes back to the card", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till, { price: 100_000n });
    const b = await createStockedProduct(till, { price: 40_000n });
    const s = await sell(till, [{ variantId: a.variant.id }], (p) => [
      { method: "CARD", amount: p.toString(), reference: "TERM-9" },
    ]);
    const xc = await exchangeFor([{ variantId: b.variant.id }], () => [], 40_000n);
    const { result, input } = await doExchange(till, s, xc);
    expect(result.exchange!.netRefund).toBe(60_000n);
    const rows = await db.refundPayment.findMany({
      where: { refundId: input.refundId },
      orderBy: { method: "asc" },
    });
    expect(rows.map((r) => [r.method, r.amount])).toEqual([
      ["CARD", 60_000n],
      ["EXCHANGE_CREDIT", 40_000n],
    ]);
    expect(rows.find((r) => r.method === "CARD")!.reference).toBe("TERM-9");
  });
});
