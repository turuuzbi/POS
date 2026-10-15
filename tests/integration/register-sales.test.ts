import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { toWire } from "@/domain/checkout-contract";
import { lineProgress, planRefund } from "@/domain/refund";
import { saleState } from "@/lib/refunds/plan";
import {
  recentSalesResultSchema,
  returnSaleWireSchema,
  toPreviousRefunds,
  toRefundSnapshot,
} from "@/lib/refunds/sale-wire";
import {
  findReturnSale,
  listRecentSales,
  refundWindowDays,
  roundingUnit,
} from "@/server/queries/register-sales";
import { checkoutSale } from "@/server/services/checkout";
import { buildInput, createStockedProduct, createTill, lineOf } from "../support/checkout-fixtures";
import { db, resetDatabase } from "../support/db";

/** One cash sale of `qty` pieces through the real checkout. */
async function sell(till: Awaited<ReturnType<typeof createTill>>, variantId: string, qty = 2) {
  const gross = 99_900n * BigInt(qty);
  const input = buildInput({
    lines: [lineOf(variantId, qty * 1000)],
    expectedPayable: gross.toString(),
    tenders: [{ method: "CASH", amount: gross.toString(), tendered: gross.toString() }],
  });
  return checkoutSale(input, till.ctx());
}

describe("register sales queries (Returns screen)", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("finds a sale by number, share token and id, and the wire parses back to the same money", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n, cost: 40_000n });
    const sold = await sell(till, variant.id);
    const scope = { locationId: till.location.id, registerId: till.register.id };

    const byNumber = await findReturnSale(scope, { kind: "number", number: sold.receiptNumber });
    expect(byNumber?.id).toBe(sold.saleId);
    const byToken = await findReturnSale(scope, { kind: "token", token: sold.shareToken });
    expect(byToken?.id).toBe(sold.saleId);
    const byId = await findReturnSale(scope, { kind: "id", id: sold.saleId });
    expect(byId?.number).toBe(sold.receiptNumber);

    const wire = JSON.parse(JSON.stringify(toWire(byNumber)));
    const parsed = returnSaleWireSchema.parse(wire);
    expect(parsed.totalAmount).toBe(sold.totals.payable);
    expect(parsed.status).toBe("COMPLETED");
    expect(parsed.shiftId).toBe(till.shift!.id);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({ qtyMilli: 2000, tracksStock: true, isGiftCard: false });
    expect(parsed.payments[0]).toMatchObject({ method: "CASH" });
    // No cost data crosses to the register.
    expect(JSON.stringify(wire)).not.toMatch(/unitCost/);

    // The client's snapshot is accepted by the domain planner.
    const plan = planRefund(
      toRefundSnapshot(parsed),
      toPreviousRefunds(parsed),
      {
        reason: "DEFECTIVE",
        lines: [{ saleLineId: parsed.lines[0]!.id, qtyMilli: 1000, restock: true }],
      },
      {
        shiftOpen: true,
        now: new Date(),
        roundingUnit: await roundingUnit(),
        grants: { refund: true, methodOverride: true, outsideWindow: true },
      },
    );
    expect(plan.ok).toBe(true);
  });

  it("only returns sales of the device's own location", async () => {
    const till = await createTill();
    const other = await createTill();
    const { variant } = await createStockedProduct(other, { price: 99_900n });
    const foreign = await sell(other, variant.id);
    const scope = { locationId: till.location.id, registerId: till.register.id };
    expect(
      await findReturnSale(scope, { kind: "number", number: foreign.receiptNumber }),
    ).toBeNull();
    expect(await findReturnSale(scope, { kind: "id", id: foreign.saleId })).toBeNull();
    expect(await findReturnSale(scope, { kind: "token", token: foreign.shareToken })).toBeNull();
    const recent = await listRecentSales(scope, { shiftId: null, query: "" });
    expect(recent.sales).toEqual([]);
  });

  it("shows refunds already made, and a void, so the screen can say what is still possible", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n, cost: 40_000n });
    const sold = await sell(till, variant.id, 3);
    const scope = { locationId: till.location.id, registerId: till.register.id };
    const sale = (await findReturnSale(scope, { kind: "id", id: sold.saleId }))!;
    const line = sale.lines[0]!;
    const payment = sale.payments[0]!;

    // A refund of one piece, written the way the service will (append-only rows).
    const refundId = uuidv7();
    await db.refund.create({
      data: {
        id: refundId,
        number: `${till.location.code}-R-000001`,
        saleId: sale.id,
        locationId: till.location.id,
        registerId: till.register.id,
        shiftId: till.shift!.id,
        processedById: till.cashier.id,
        reason: "DEFECTIVE",
        netAmount: 90_818n,
        vatAmount: 9_082n,
        totalAmount: 99_900n,
        occurredAt: new Date(),
        lines: {
          create: [
            {
              saleLineId: line.id,
              qtyMilli: 1000,
              restock: true,
              netAmount: 90_818n,
              vatAmount: 9_082n,
              totalAmount: 99_900n,
              unitCost: 40_000n,
            },
          ],
        },
        payments: { create: [{ method: "CASH", amount: 99_900n, originalPaymentId: payment.id }] },
      },
    });

    const after = returnSaleWireSchema.parse(
      JSON.parse(
        JSON.stringify(toWire(await findReturnSale(scope, { kind: "id", id: sold.saleId }))),
      ),
    );
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]!.lines[0]).toMatchObject({ qtyMilli: 1000, restock: true });
    expect(saleState(after)).toBe("PARTIALLY_REFUNDED");
    const progress = lineProgress(toRefundSnapshot(after), toPreviousRefunds(after));
    expect(progress[0]!.remainingQtyMilli).toBe(2000);

    const recent = await listRecentSales(scope, { shiftId: till.shift!.id, query: "" });
    expect(recent.sales).toHaveLength(1);
    expect(recent.sales[0]!.state).toBe("PARTIALLY_REFUNDED");

    // A second sale, voided.
    const second = await sell(till, variant.id, 1);
    await db.saleVoid.create({
      data: {
        saleId: second.saleId,
        shiftId: till.shift!.id,
        reason: "ENTRY_ERROR",
        voidedById: till.cashier.id,
      },
    });
    const voided = returnSaleWireSchema.parse(
      JSON.parse(
        JSON.stringify(toWire(await findReturnSale(scope, { kind: "id", id: second.saleId }))),
      ),
    );
    expect(voided.status).toBe("VOIDED");
    expect(voided.voided?.reason).toBe("ENTRY_ERROR");
    expect(saleState(voided)).toBe("VOIDED");
  });

  it("lists recent sales newest first, by shift or register, with number search", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n });
    const first = await sell(till, variant.id, 1);
    const second = await sell(till, variant.id, 2);
    const scope = { locationId: till.location.id, registerId: till.register.id };

    const all = recentSalesResultSchema.parse(
      JSON.parse(
        JSON.stringify(toWire(await listRecentSales(scope, { shiftId: null, query: "" }))),
      ),
    );
    expect(all.sales.map((s) => s.number)).toEqual([second.receiptNumber, first.receiptNumber]);
    expect(all.sales[0]).toMatchObject({ lineCount: 1, methods: ["CASH"], state: "OK" });
    expect(all.truncated).toBe(false);

    const found = await listRecentSales(scope, {
      shiftId: till.shift!.id,
      query: first.receiptNumber.slice(-4).toLowerCase(),
    });
    expect(found.sales.map((s) => s.number)).toEqual([first.receiptNumber]);

    // Another shift of the same register is not "this shift".
    const closed = await db.shift.create({
      data: {
        registerId: till.register.id,
        locationId: till.location.id,
        openedById: till.cashier.id,
        openingFloat: 0n,
        status: "CLOSED",
        closedAt: new Date(),
        closedById: till.cashier.id,
      },
    });
    expect((await listRecentSales(scope, { shiftId: closed.id, query: "" })).sales).toEqual([]);
  });

  it("does not list another register's sales", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n });
    await sell(till, variant.id, 1);
    const sibling = await db.register.create({
      data: { locationId: till.location.id, code: "R2", name: "Register two" },
    });
    const scope = { locationId: till.location.id, registerId: sibling.id };
    expect((await listRecentSales(scope, { shiftId: null, query: "" })).sales).toEqual([]);
    // ...but the location-wide lookup by number still finds it (a customer may return at any till).
    const sale = await db.sale.findFirstOrThrow();
    expect(await findReturnSale(scope, { kind: "number", number: sale.number })).not.toBeNull();
  });

  it("reads the refund window from the environment, ignoring junk", () => {
    expect(refundWindowDays({ POS_REFUND_WINDOW_DAYS: "30" } as unknown as NodeJS.ProcessEnv)).toBe(
      30,
    );
    expect(refundWindowDays({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      refundWindowDays({ POS_REFUND_WINDOW_DAYS: "0" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      refundWindowDays({ POS_REFUND_WINDOW_DAYS: "abc" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      refundWindowDays({ POS_REFUND_WINDOW_DAYS: "-5" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
