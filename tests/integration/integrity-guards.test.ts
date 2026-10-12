import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDatabase } from "../support/db";
import { createLocation, createUser } from "../support/fixtures";

/**
 * The database itself refuses to rewrite history: append-only triggers on
 * financial/ledger tables and CHECK constraints on invariants.
 */
describe("append-only tables", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  async function saleFixture() {
    const { location, register } = await createLocation();
    const cashier = await createUser({ role: "CASHIER", locationIds: [location.id] });
    const shift = await db.shift.create({
      data: {
        registerId: register.id,
        locationId: location.id,
        openedById: cashier.id,
        openingFloat: 0n,
      },
    });
    const sale = await db.sale.create({
      data: {
        id: "0193b7c4-0000-7000-8000-00000000a001",
        number: "L-000001",
        locationId: location.id,
        registerId: register.id,
        shiftId: shift.id,
        cashierId: cashier.id,
        occurredAt: new Date(),
        netAmount: 90_909n,
        vatAmount: 9_091n,
        itemsAmount: 100_000n,
        totalAmount: 100_000n,
        publicToken: "tok-1",
      },
    });
    return { sale, cashier, location };
  }

  it("rejects UPDATE and DELETE on sales", async () => {
    const { sale } = await saleFixture();
    await expect(
      db.sale.update({ where: { id: sale.id }, data: { note: "edited" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.sale.delete({ where: { id: sale.id } })).rejects.toThrow(/append-only/);
    expect(await db.sale.count()).toBe(1);
  });

  it("rejects UPDATE and DELETE on the audit log", async () => {
    await db.auditLog.create({ data: { action: "test", entityType: "Test" } });
    await expect(db.auditLog.updateMany({ data: { action: "tampered" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.auditLog.deleteMany()).rejects.toThrow(/append-only/);
    expect((await db.auditLog.findFirstOrThrow()).action).toBe("test");
  });

  it("rejects UPDATE on stock movements", async () => {
    const { location, cashier } = await saleFixture();
    const taxClass = await db.taxClass.create({ data: { name: "VAT 10%" } });
    const product = await db.product.create({
      data: { name: "Test", taxClassId: taxClass.id, variants: { create: { price: 100_00n } } },
      include: { variants: true },
    });
    const movement = await db.stockMovement.create({
      data: {
        variantId: product.variants[0]!.id,
        locationId: location.id,
        type: "OPENING",
        qtyDeltaMilli: 5000,
        balanceAfterMilli: 5000,
        createdById: cashier.id,
      },
    });
    await expect(
      db.stockMovement.update({ where: { id: movement.id }, data: { qtyDeltaMilli: 9000 } }),
    ).rejects.toThrow(/append-only/);
  });

  it("still allows inserts", async () => {
    await db.auditLog.create({ data: { action: "a", entityType: "T" } });
    await db.auditLog.create({ data: { action: "b", entityType: "T" } });
    expect(await db.auditLog.count()).toBe(2);
  });
});

describe("CHECK constraints", () => {
  beforeEach(resetDatabase);

  it("keeps BusinessSettings a singleton", async () => {
    await db.businessSettings.create({ data: { id: 1, businessName: "Shop" } });
    await expect(
      db.businessSettings.create({ data: { id: 2, businessName: "Other" } }),
    ).rejects.toThrow(/BusinessSettings_singleton/);
  });

  it("rejects negative prices and out-of-range tax rates", async () => {
    const taxClass = await db.taxClass.create({ data: { name: "VAT" } });
    await expect(
      db.product.create({
        data: { name: "Bad", taxClassId: taxClass.id, variants: { create: { price: -1n } } },
      }),
    ).rejects.toThrow(/ProductVariant_price_nonneg/);
    await expect(db.taxClass.create({ data: { name: "Bad", vatRateBps: 10_001 } })).rejects.toThrow(
      /TaxClass_rates_range/,
    );
  });

  it("rejects a sale whose total doesn't add up", async () => {
    const { location, register } = await createLocation();
    const cashier = await createUser({ role: "CASHIER" });
    const shift = await db.shift.create({
      data: {
        registerId: register.id,
        locationId: location.id,
        openedById: cashier.id,
        openingFloat: 0n,
      },
    });
    await expect(
      db.sale.create({
        data: {
          id: "0193b7c4-0000-7000-8000-00000000a002",
          number: "L-000002",
          locationId: location.id,
          registerId: register.id,
          shiftId: shift.id,
          cashierId: cashier.id,
          occurredAt: new Date(),
          netAmount: 100n,
          vatAmount: 0n,
          itemsAmount: 100n,
          totalAmount: 999n, // ≠ items + tip + rounding
          publicToken: "tok-2",
        },
      }),
    ).rejects.toThrow(/Sale_amounts_valid/);
  });

  it("only allows change on cash payments", async () => {
    await expect(
      db.$executeRaw`INSERT INTO "SalePayment" (id, "saleId", method, amount, change)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'CARD', 100, 5)`,
    ).rejects.toThrow(/SalePayment_amounts_valid/);
  });
});
