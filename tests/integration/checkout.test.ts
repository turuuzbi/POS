import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeTotals, type CatalogSnapshot } from "@/domain/cart";
import { checkoutCodeFromFailure } from "@/domain/checkout-failure";
import { approvalKeys, approvalScope } from "@/domain/discounts";
import { buildScaleBarcode } from "@/domain/scale-barcode";
import { units } from "@/domain/qty";
import { markMockInvoicePaid } from "@/server/adapters/payments";
import { signApproval } from "@/server/auth/approval";
import { CheckoutFailure, checkoutSale } from "@/server/services/checkout";
import { createQpayInvoice } from "@/server/services/payments";
import { findLedgerMismatches } from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import {
  buildInput,
  createStockedProduct,
  createTill,
  lineOf,
  type Till,
} from "../support/checkout-fixtures";

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CheckoutFailure);
    return (error as CheckoutFailure).failure;
  }
  throw new Error("expected the checkout to fail");
}

const onHand = async (till: Till, variantId: string) =>
  (
    await db.stockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: till.location.id } },
    })
  )?.onHandMilli ?? 0;

describe("checkoutSale", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("records a cash sale whose totals equal the shared domain computation", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n, cost: 40_000n });
    const catalog: CatalogSnapshot = {
      variants: {
        [variant.id]: {
          variantId: variant.id,
          unit: "PIECE",
          price: 99_900n,
          pricesIncludeTax: true,
          taxTreatment: "STANDARD",
          vatRateBps: 1000,
          cityTaxRateBps: 0,
        },
      },
    };
    const line = lineOf(variant.id, units(3), {
      discounts: [{ kind: "PERCENT", percentBps: 500 }],
    });
    const expected = computeTotals(
      {
        lines: [
          {
            lineId: line.lineId,
            variantId: variant.id,
            qtyMilli: units(3),
            unitPrice: 99_900n,
            discounts: [{ kind: "PERCENT", percentBps: 500 }],
          },
        ],
        discounts: [],
      },
      catalog,
    );
    const input = buildInput({
      lines: [line],
      expectedPayable: expected.payable.toString(),
      tenders: [{ method: "CASH", amount: expected.payable.toString(), tendered: "1000000" }],
    });
    const result = await checkoutSale(input, till.ctx());

    expect(result.replayed).toBe(false);
    expect(result.status).toBe("COMPLETED");
    expect(result.receiptNumber).toBe(`${till.location.code}-000001`);
    expect(result.totals.payable).toBe(expected.payable);
    expect(result.totals.vatTotal).toBe(expected.vatTotal);
    expect(result.totals.netTotal).toBe(expected.netTotal);
    expect(result.totals.discountTotal).toBe(expected.discountTotal);
    expect(result.change).toBe(1_000_000n - expected.payable);
    expect(result.shareToken.length).toBeGreaterThanOrEqual(22); // >= 128 bits base64url

    const sale = await db.sale.findUniqueOrThrow({
      where: { id: input.saleId },
      include: { lines: true, discounts: true, payments: true, stockMovements: true },
    });
    expect(sale.cashierId).toBe(till.cashier.id);
    expect(sale.shiftId).toBe(till.shift!.id);
    expect(sale.registerId).toBe(till.register.id);
    expect(sale.totalAmount).toBe(expected.payable);
    expect(sale.itemsAmount).toBe(expected.total);
    expect(sale.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const saleLine = sale.lines[0]!;
    expect(saleLine).toMatchObject({
      unitCost: 40_000n,
      catalogUnitPrice: 99_900n,
      unitPrice: 99_900n,
      qtyMilli: units(3),
      totalAmount: expected.lines[0]!.gross,
      discountAmount: expected.lines[0]!.discount,
    });
    expect(saleLine.netAmount + saleLine.vatAmount + saleLine.cityTaxAmount).toBe(
      saleLine.totalAmount,
    );
    expect(sale.discounts).toHaveLength(1);
    expect(sale.discounts[0]).toMatchObject({ scope: "LINE", kind: "PERCENT", percentBps: 500 });
    expect(sale.payments[0]).toMatchObject({ method: "CASH", tendered: 1_000_000n });
    expect(sale.stockMovements).toHaveLength(1);
    expect(sale.stockMovements[0]).toMatchObject({ type: "SALE", qtyDeltaMilli: -units(3) });
    expect(await onHand(till, variant.id)).toBe(100_000 - units(3));
    expect(await findLedgerMismatches(db)).toEqual([]);

    const audits = await db.auditLog.findMany({ where: { entityId: input.saleId } });
    expect(audits.map((a) => a.action)).toContain("sale.checkout");
  });

  it("replays an identical request with the same sale, no second charge", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id, units(2))],
      expectedPayable: "200000",
      tenders: [{ method: "CASH", amount: "200000" }],
    });
    const first = await checkoutSale(input, till.ctx());
    const second = await checkoutSale(
      { ...input, approvals: { x: "fresh-token" }, createdAtClient: new Date().toISOString() },
      till.ctx(),
    );
    expect(second.replayed).toBe(true);
    expect({ ...second, replayed: false }).toEqual(first);
    expect(await db.sale.count()).toBe(1);
    expect(await db.stockMovement.count({ where: { type: "SALE" } })).toBe(1);
    expect(await onHand(till, variant.id)).toBe(100_000 - units(2));
  });

  it("answers a replay of the same sale id with different content as IDEMPOTENCY_CONFLICT", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id, units(1))],
      expectedPayable: "100000",
      tenders: [{ method: "CASH", amount: "100000" }],
    });
    await checkoutSale(input, till.ctx());
    const different = buildInput({
      saleId: input.saleId,
      lines: [lineOf(variant.id, units(2))],
      expectedPayable: "200000",
      tenders: [{ method: "CASH", amount: "200000" }],
    });
    expect(await failure(checkoutSale(different, till.ctx()))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await db.sale.count()).toBe(1);
  });

  it("refuses to replay another cashier's sale", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "100000",
      tenders: [{ method: "CASH", amount: "100000" }],
    });
    await checkoutSale(input, till.ctx());
    expect(await failure(checkoutSale(input, till.ctx(till.manager)))).toBe(
      "SALE_OWNERSHIP_MISMATCH",
    );
  });

  it("20 parallel identical requests create exactly one sale and one set of movements", async () => {
    const till = await createTill();
    const a = await createStockedProduct(till);
    const b = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(a.variant.id, units(2)), lineOf(b.variant.id, units(1))],
      expectedPayable: "300000",
      tenders: [{ method: "CASH", amount: "300000" }],
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkoutSale(input, till.ctx())),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receiptNumber)).size).toBe(1);
    expect(new Set(results.map((r) => r.shareToken)).size).toBe(1);
    expect(await db.sale.count()).toBe(1);
    expect(await db.saleLine.count()).toBe(2);
    expect(await db.salePayment.count()).toBe(1);
    expect(await db.stockMovement.count({ where: { type: "SALE" } })).toBe(2);
    expect(await onHand(till, a.variant.id)).toBe(100_000 - units(2));
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("serialises concurrent different sales of one item: gap-free numbers, no lost stock", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { stockMilli: units(50) });
    const inputs = Array.from({ length: 12 }, () =>
      buildInput({
        lines: [lineOf(variant.id, units(2))],
        expectedPayable: "200000",
        tenders: [{ method: "CASH", amount: "200000" }],
      }),
    );
    const results = await Promise.all(inputs.map((i) => checkoutSale(i, till.ctx())));
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(await onHand(till, variant.id)).toBe(units(50) - units(24));
    const numbers = results.map((r) => Number(r.receiptNumber.split("-")[1])).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const chain = await db.stockMovement.findMany({
      where: { type: "SALE" },
      orderBy: { seq: "asc" },
    });
    expect(chain.map((m) => m.balanceAfterMilli)).toEqual(
      Array.from({ length: 12 }, (_, i) => units(50) - units(2) * (i + 1)),
    );
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("splits tender across cash and card and returns the change from cash", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id, units(5))], // 5 000₮
      expectedPayable: "500000",
      tenders: [
        {
          method: "CARD",
          amount: "300000",
          reference: "TERM-1",
          cardBrand: "VISA",
          cardLast4: "4242",
        },
        { method: "CASH", amount: "200000", tendered: "500000" },
      ],
    });
    const result = await checkoutSale(input, till.ctx());
    expect(result.change).toBe(300_000n);
    expect(result.payments.map((p) => [p.method, p.amount, p.change])).toEqual([
      ["CARD", 300_000n, 0n],
      ["CASH", 200_000n, 300_000n],
    ]);
    const rows = await db.salePayment.findMany({ where: { saleId: input.saleId } });
    expect(rows.find((r) => r.method === "CARD")).toMatchObject({
      reference: "TERM-1",
      cardLast4: "4242",
    });
  });

  it("rejects bad tenders: underpaid, overpaid card, duplicate references", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const base = { lines: [lineOf(variant.id)], expectedPayable: "100000" };
    expect(
      await failure(
        checkoutSale(
          buildInput({ ...base, tenders: [{ method: "CASH", amount: "90000" }] }),
          till.ctx(),
        ),
      ),
    ).toBe("TENDER_UNDERPAID");
    expect(
      await failure(
        checkoutSale(
          buildInput({ ...base, tenders: [{ method: "CARD", amount: "150000" }] }),
          till.ctx(),
        ),
      ),
    ).toBe("TENDER_OVERPAID");
    expect(
      await failure(
        checkoutSale(
          buildInput({
            ...base,
            tenders: [
              { method: "BANK_TRANSFER", amount: "50000", reference: "T1" },
              { method: "BANK_TRANSFER", amount: "50000", reference: "T1" },
            ],
          }),
          till.ctx(),
        ),
      ),
    ).toBe("DUPLICATE_TENDER_REFERENCE");
    expect(await db.sale.count()).toBe(0);
  });

  it("rounds the payable to the configured unit and stores the signed difference", async () => {
    await db.businessSettings.create({
      data: { id: 1, businessName: "Test", totalRoundingUnit: 1000n },
    });
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 123_400n });
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "123000",
      tenders: [{ method: "CASH", amount: "123000" }],
    });
    const result = await checkoutSale(input, till.ctx());
    expect(result.totals.total).toBe(123_400n);
    expect(result.totals.roundingAmount).toBe(-400n);
    expect(result.totals.payable).toBe(123_000n);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: input.saleId } });
    expect([sale.itemsAmount, sale.roundingAmount, sale.totalAmount]).toEqual([
      123_400n,
      -400n,
      123_000n,
    ]);
  });

  it("never trusts client prices: stale price and total mismatch are refused", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const tenders = [{ method: "CASH" as const, amount: "100000" }];
    expect(
      await failure(
        checkoutSale(
          buildInput({
            lines: [lineOf(variant.id, 1000, { listedUnitPrice: "90000" })],
            expectedPayable: "90000",
            tenders: [{ method: "CASH", amount: "90000" }],
          }),
          till.ctx(),
        ),
      ),
    ).toBe("STALE_PRICE");
    expect(
      await failure(
        checkoutSale(
          buildInput({ lines: [lineOf(variant.id)], expectedPayable: "90000", tenders }),
          till.ctx(),
        ),
      ),
    ).toBe("TOTAL_MISMATCH");
    expect(await db.sale.count()).toBe(0);
    expect(await db.stockMovement.count({ where: { type: "SALE" } })).toBe(0);
  });

  describe("approvals", () => {
    const priceScope = (saleId: string, lineId: string, price: string) =>
      approvalScope(saleId, { key: approvalKeys.linePrice(lineId), value: `price:${price}` });
    const discountScope = (saleId: string, lineId: string, value: string, i = 0) =>
      approvalScope(saleId, { key: approvalKeys.lineDiscount(lineId, i), value });
    const overrideLine = (variantId: string) => lineOf(variantId, 1000, { priceOverride: "80000" });

    it("requires approval for a cashier's price override", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const input = buildInput({
        lines: [overrideLine(variant.id)],
        expectedPayable: "80000",
        tenders: [{ method: "CASH", amount: "80000" }],
      });
      expect(await failure(checkoutSale(input, till.ctx()))).toBe("APPROVAL_REQUIRED");
      expect(await db.sale.count()).toBe(0);
    });

    it("accepts a manager token bound to the sale and records the approver", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const line = overrideLine(variant.id);
      const saleId = uuidv7();
      const token = signApproval({
        approverId: till.manager.id,
        permission: "pos.price_override",
        scope: priceScope(saleId, line.lineId, "80000"),
        deviceId: till.device.id,
      });
      const input = buildInput({
        saleId,
        lines: [line],
        expectedPayable: "80000",
        approvals: { [approvalKeys.linePrice(line.lineId)]: token },
        tenders: [{ method: "CASH", amount: "80000" }],
      });
      await checkoutSale(input, till.ctx());
      const saleLine = await db.saleLine.findFirstOrThrow({ where: { saleId } });
      expect(saleLine).toMatchObject({
        catalogUnitPrice: 100_000n,
        unitPrice: 80_000n,
        priceOverrideById: till.manager.id,
      });
      const used = await db.auditLog.findMany({ where: { action: "sale.approval_used" } });
      expect(used.map((a) => a.actorId)).toEqual([till.manager.id]);
    });

    it("rejects tokens that are forged, for another sale, device or permission", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const line = overrideLine(variant.id);
      const key = approvalKeys.linePrice(line.lineId);
      const saleId = uuidv7();
      const make = (claims: Partial<Parameters<typeof signApproval>[0]> = {}) =>
        signApproval({
          approverId: till.manager.id,
          permission: "pos.price_override",
          scope: priceScope(saleId, line.lineId, "80000"),
          deviceId: till.device.id,
          ...claims,
        });
      const attempt = (token: string) =>
        checkoutSale(
          buildInput({
            saleId,
            lines: [line],
            expectedPayable: "80000",
            approvals: { [key]: token },
            tenders: [{ method: "CASH", amount: "80000" }],
          }),
          till.ctx(),
        );
      for (const token of [
        "garbage",
        `${make()}x`,
        make({ scope: uuidv7() }),
        make({ deviceId: uuidv7() }),
        make({ permission: "pos.discount.manual" }),
      ]) {
        expect(await failure(attempt(token))).toBe("APPROVAL_INVALID");
      }
      // A token from someone who lacks the permission (a cashier) is invalid too.
      expect(await failure(attempt(make({ approverId: till.cashier.id })))).toBe(
        "APPROVAL_INVALID",
      );
      expect(await db.sale.count()).toBe(0);
    });

    it("rejects a token reused for a larger discount, another line, a bare sale id or another price", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const { variant: variantB } = await createStockedProduct(till);
      const saleId = uuidv7();
      const sign = (scope: string) =>
        signApproval({
          approverId: till.manager.id,
          permission: "pos.discount.manual",
          scope,
          deviceId: till.device.id,
        });
      const lineA = lineOf(variant.id, 1000, {
        discounts: [{ kind: "PERCENT", percentBps: 1500 }],
      });
      const lineB = lineOf(variantB.id, 1000, {
        discounts: [{ kind: "PERCENT", percentBps: 1500 }],
      });
      const big = lineOf(variant.id, 1000, { discounts: [{ kind: "PERCENT", percentBps: 5000 }] });
      big.lineId = lineA.lineId;
      const keyA = approvalKeys.lineDiscount(lineA.lineId, 0);
      const keyB = approvalKeys.lineDiscount(lineB.lineId, 0);
      const tokenA = sign(discountScope(saleId, lineA.lineId, "pct:1500"));
      const attempt = (
        lines: (typeof lineA)[],
        approvals: Record<string, string>,
        payable: string,
      ) =>
        checkoutSale(
          buildInput({
            saleId,
            lines,
            expectedPayable: payable,
            approvals,
            tenders: [{ method: "CASH", amount: payable }],
          }),
          till.ctx(),
        );
      // 15% token reused at 50%
      expect(await failure(attempt([big], { [keyA]: tokenA }, "50000"))).toBe("APPROVAL_INVALID");
      // line A's token presented for line B
      expect(
        await failure(attempt([lineA, lineB], { [keyA]: tokenA, [keyB]: tokenA }, "170000")),
      ).toBe("APPROVAL_INVALID");
      // bare sale id scope
      expect(await failure(attempt([lineA], { [keyA]: sign(saleId) }, "85000"))).toBe(
        "APPROVAL_INVALID",
      );
      // exact match is accepted
      const ok = await attempt([lineA], { [keyA]: tokenA }, "85000");
      expect(ok.totals.payable).toBe(85_000n);
    });

    it("lets a manager override and discount without a token", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const line = lineOf(variant.id, 1000, {
        priceOverride: "80000",
        discounts: [{ kind: "PERCENT", percentBps: 2500 }],
      });
      const result = await checkoutSale(
        buildInput({
          lines: [line],
          expectedPayable: "60000",
          tenders: [{ method: "CASH", amount: "60000" }],
        }),
        till.ctx(till.manager),
      );
      expect(result.totals.payable).toBe(60_000n);
      const discount = await db.saleDiscount.findFirstOrThrow();
      expect(discount.approvedById).toBe(till.manager.id);
    });

    it("small discounts need no approval; large cart discounts do", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const small = await checkoutSale(
        buildInput({
          lines: [lineOf(variant.id, 1000, { discounts: [{ kind: "PERCENT", percentBps: 1000 }] })],
          expectedPayable: "90000",
          tenders: [{ method: "CASH", amount: "90000" }],
        }),
        till.ctx(),
      );
      expect(small.totals.payable).toBe(90_000n);
      const big = buildInput({
        lines: [lineOf(variant.id)],
        cartDiscounts: [{ kind: "PERCENT", percentBps: 3000 }],
        expectedPayable: "70000",
        tenders: [{ method: "CASH", amount: "70000" }],
      });
      expect(await failure(checkoutSale(big, till.ctx()))).toBe("APPROVAL_REQUIRED");
    });
  });

  it("requires an open shift on the device's register", async () => {
    const till = await createTill({ withShift: false });
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "100000",
      tenders: [{ method: "CASH", amount: "100000" }],
    });
    expect(await failure(checkoutSale(input, till.ctx()))).toBe("SHIFT_REQUIRED");
    // A shift on ANOTHER register does not help.
    const other = await db.register.create({
      data: { locationId: till.location.id, code: "R2", name: "Register 2" },
    });
    await db.shift.create({
      data: {
        registerId: other.id,
        locationId: till.location.id,
        openedById: till.cashier.id,
        openingFloat: 0n,
      },
    });
    expect(await failure(checkoutSale(input, till.ctx()))).toBe("SHIFT_REQUIRED");
    // And a cashier of another location is refused outright.
    const elsewhere = await createTill();
    expect(await failure(checkoutSale(input, { ...till.ctx(), user: elsewhere.ctx().user }))).toBe(
      "PERMISSION_DENIED",
    );
    expect(await db.sale.count()).toBe(0);
  });

  it("rejects inactive and archived variants and unknown ids", async () => {
    const till = await createTill();
    const inactive = await createStockedProduct(till);
    await db.productVariant.update({
      where: { id: inactive.variant.id },
      data: { isActive: false },
    });
    const archived = await createStockedProduct(till);
    await db.product.update({ where: { id: archived.product.id }, data: { isActive: false } });
    const attempt = (variantId: string) =>
      checkoutSale(
        buildInput({
          lines: [lineOf(variantId)],
          expectedPayable: "100000",
          tenders: [{ method: "CASH", amount: "100000" }],
        }),
        till.ctx(),
      );
    expect(await failure(attempt(inactive.variant.id))).toBe("VARIANT_INACTIVE");
    expect(await failure(attempt(archived.variant.id))).toBe("VARIANT_INACTIVE");
    expect(await failure(attempt(uuidv7()))).toBe("VARIANT_NOT_FOUND");
  });

  it("sells weighed items by milli-kilograms and from scale labels", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, {
      unit: "KG",
      price: 1_200_000n, // 12 000₮ / kg
      stockMilli: 10_000,
    });
    await db.productVariant.update({ where: { id: variant.id }, data: { pluCode: "123" } });

    const weighed = await checkoutSale(
      buildInput({
        lines: [lineOf(variant.id, 1250)],
        expectedPayable: "1500000",
        tenders: [{ method: "CASH", amount: "1500000" }],
      }),
      till.ctx(),
    );
    expect(weighed.totals.payable).toBe(1_500_000n); // 1.250 kg x 12 000₮
    expect(await onHand(till, variant.id)).toBe(10_000 - 1250);

    const label = buildScaleBarcode(
      { prefix: "20", itemCodeLength: 5, valueType: "WEIGHT", valueLength: 5, valueDecimals: 3 },
      "123",
      500,
    );
    const scaled = await checkoutSale(
      buildInput({
        lines: [{ lineId: uuidv7(), scaleBarcode: label, discounts: [] }],
        expectedPayable: "600000",
        tenders: [{ method: "CASH", amount: "600000" }],
      }),
      till.ctx(),
    );
    expect(scaled.totals.payable).toBe(600_000n);
    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: scaled.saleId },
    });
    expect(line).toMatchObject({ qtyMilli: 500, unit: "KG", variantId: variant.id });
    expect(await onHand(till, variant.id)).toBe(10_000 - 1250 - 500);
    expect(await findLedgerMismatches(db)).toEqual([]);

    const bad = buildInput({
      lines: [{ lineId: uuidv7(), scaleBarcode: "2099999000000", discounts: [] }],
      expectedPayable: "1",
      tenders: [{ method: "CASH", amount: "100" }],
    });
    expect(["INVALID_SCALE_BARCODE", "VARIANT_NOT_FOUND"]).toContain(
      await failure(checkoutSale(bad, till.ctx())),
    );
  });

  describe("stock", () => {
    it("sells through into negative stock by default (decision 6)", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { stockMilli: units(1) });
      const result = await checkoutSale(
        buildInput({
          lines: [lineOf(variant.id, units(3))],
          expectedPayable: "300000",
          tenders: [{ method: "CASH", amount: "300000" }],
        }),
        till.ctx(),
      );
      expect(result.status).toBe("COMPLETED");
      expect(await onHand(till, variant.id)).toBe(-units(2));
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("refuses and leaves no trace when allowNegativeStock is off", async () => {
      await db.businessSettings.create({
        data: { id: 1, businessName: "Test", allowNegativeStock: false },
      });
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { stockMilli: units(1) });
      const input = buildInput({
        lines: [lineOf(variant.id, units(3))],
        expectedPayable: "300000",
        tenders: [{ method: "CASH", amount: "300000" }],
      });
      expect(await failure(checkoutSale(input, till.ctx()))).toBe("INSUFFICIENT_STOCK");
      expect(await db.sale.count()).toBe(0);
      expect(await db.salePayment.count()).toBe(0);
      expect(await onHand(till, variant.id)).toBe(units(1));
      // The receipt number was rolled back with the transaction: the next sale is #1.
      const ok = await checkoutSale(
        buildInput({
          lines: [lineOf(variant.id, units(1))],
          expectedPayable: "100000",
          tenders: [{ method: "CASH", amount: "100000" }],
        }),
        till.ctx(),
      );
      expect(ok.receiptNumber).toBe(`${till.location.code}-000001`);
    });

    it("does not move stock for services or untracked items", async () => {
      const till = await createTill();
      const service = await createStockedProduct(till, { type: "SERVICE", trackStock: false });
      const untracked = await createStockedProduct(till, { trackStock: false });
      await checkoutSale(
        buildInput({
          lines: [lineOf(service.variant.id), lineOf(untracked.variant.id)],
          expectedPayable: "200000",
          tenders: [{ method: "CASH", amount: "200000" }],
        }),
        till.ctx(),
      );
      expect(await db.stockMovement.count({ where: { type: "SALE" } })).toBe(0);
      expect(await db.saleLine.count()).toBe(2);
    });
  });

  describe("QPay", () => {
    async function invoiceFor(till: Till, saleId: string, amount: bigint) {
      const invoice = await createQpayInvoice(
        { saleId, amount },
        till.ctx().user,
        till.ctx().device,
        { ip: null, userAgent: null },
      );
      const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
      return { invoice, intent };
    }

    it("refuses an unpaid intent and accepts it once the provider reports it paid", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const saleId = uuidv7();
      const { invoice, intent } = await invoiceFor(till, saleId, 100_000n);
      const input = buildInput({
        saleId,
        lines: [lineOf(variant.id)],
        expectedPayable: "100000",
        tenders: [{ method: "QPAY", amount: "100000", paymentIntentId: invoice.intentId }],
      });
      expect(await failure(checkoutSale(input, till.ctx()))).toBe("PAYMENT_NOT_CONFIRMED");
      expect(await db.sale.count()).toBe(0);

      markMockInvoicePaid(intent.providerRef!);
      const result = await checkoutSale(input, till.ctx());
      expect(result.payments[0]).toMatchObject({ method: "QPAY", amount: 100_000n });
      const payment = await db.salePayment.findFirstOrThrow({ where: { saleId } });
      expect(payment.paymentIntentId).toBe(invoice.intentId);
      expect(payment.reference).toBeTruthy();
      const paid = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
      expect(paid.status).toBe("PAID");
      expect(paid.paidAt).not.toBeNull();
    });

    it("refuses a paid intent for another sale, another amount, or a second use", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const saleA = uuidv7();
      const a = await invoiceFor(till, saleA, 100_000n);
      markMockInvoicePaid(a.intent.providerRef!);
      const sale = (saleId: string, amount: string, intentId: string) =>
        buildInput({
          saleId,
          lines: [lineOf(variant.id, 1000)],
          expectedPayable: "100000",
          tenders: [
            { method: "QPAY", amount, paymentIntentId: intentId },
            ...(amount === "100000"
              ? []
              : [{ method: "CASH" as const, amount: String(100000 - Number(amount)) }]),
          ],
        });

      // Different amount than the invoice.
      expect(
        await failure(checkoutSale(sale(saleA, "60000", a.invoice.intentId), till.ctx())),
      ).toBe("PAYMENT_NOT_CONFIRMED");
      // Intent belongs to sale A, used for sale B.
      expect(
        await failure(checkoutSale(sale(uuidv7(), "100000", a.invoice.intentId), till.ctx())),
      ).toBe("PAYMENT_NOT_CONFIRMED");
      // Legit use, then reuse by a new sale id.
      await checkoutSale(sale(saleA, "100000", a.invoice.intentId), till.ctx());
      expect(
        await failure(checkoutSale(sale(uuidv7(), "100000", a.invoice.intentId), till.ctx())),
      ).toBe("PAYMENT_NOT_CONFIRMED");
      expect(await db.sale.count()).toBe(1);
    });

    it("rejects an unknown payment intent id", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const input = buildInput({
        lines: [lineOf(variant.id)],
        expectedPayable: "100000",
        tenders: [{ method: "QPAY", amount: "100000", paymentIntentId: uuidv7() }],
      });
      expect(await failure(checkoutSale(input, till.ctx()))).toBe("PAYMENT_NOT_CONFIRMED");
    });
  });

  it("answers gift card and store credit tenders with a clear not-available error", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "100000",
      tenders: [{ method: "GIFT_CARD", amount: "100000", giftCardCode: "ABCD-1234" }],
    });
    expect(await failure(checkoutSale(input, till.ctx()))).toBe("TENDER_NOT_AVAILABLE");
  });

  it("carries the checkout code through the action failure envelope", async () => {
    const till = await createTill({ withShift: false });
    const { variant } = await createStockedProduct(till);
    try {
      await checkoutSale(
        buildInput({
          lines: [lineOf(variant.id)],
          expectedPayable: "100000",
          tenders: [{ method: "CASH", amount: "100000" }],
        }),
        till.ctx(),
      );
      throw new Error("unreachable");
    } catch (error) {
      const e = error as CheckoutFailure;
      expect(e.code).toBe("INVALID_STATE");
      expect(checkoutCodeFromFailure({ fieldErrors: e.fieldErrors })).toEqual({
        code: "SHIFT_REQUIRED",
        messageKey: "checkout.errors.SHIFT_REQUIRED",
      });
    }
  });

  it("keeps sales append-only and snapshots immune to later catalog edits", async () => {
    const till = await createTill();
    const { variant, product } = await createStockedProduct(till, { name: "Original" });
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "100000",
      tenders: [{ method: "CASH", amount: "100000" }],
    });
    await checkoutSale(input, till.ctx());
    await db.product.update({ where: { id: product.id }, data: { name: "Renamed" } });
    await db.productVariant.update({ where: { id: variant.id }, data: { price: 5n } });
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: input.saleId } });
    expect(line.name).toBe("Original");
    expect(line.unitPrice).toBe(100_000n);

    await expect(
      db.sale.update({ where: { id: input.saleId }, data: { note: "tamper" } }),
    ).rejects.toThrow();
    await expect(db.salePayment.deleteMany({ where: { saleId: input.saleId } })).rejects.toThrow();
    await expect(db.saleLine.updateMany({ data: { qtyMilli: 1 } })).rejects.toThrow();
    await expect(
      db.stockMovement.deleteMany({ where: { saleId: input.saleId } }),
    ).rejects.toThrow();
  });
});
