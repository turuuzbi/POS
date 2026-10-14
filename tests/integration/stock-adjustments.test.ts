import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adjustmentInputSchema, type AdjustmentInput } from "@/domain/adjustments";
import { can } from "@/domain/access";
import { fromMajor } from "@/domain/money";
import { units } from "@/domain/qty";
import { createAdjustment } from "@/server/services/adjustments";
import {
  getAdjustment,
  listAdjustments,
  listLowStock,
  listStock,
  listVariantLedger,
} from "@/server/queries/stock";
import { findLedgerMismatches, postStockMovements } from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import { createLocation, createProduct, createUser } from "../support/fixtures";

async function setup() {
  const { location } = await createLocation({ name: "Main" });
  const user = await createUser({ role: "MANAGER", locationIds: [location.id] });
  const { variant } = await createProduct({ cost: fromMajor(1000) });
  await db.$transaction((tx) =>
    postStockMovements(tx, {
      locationId: location.id,
      type: "OPENING",
      createdById: user.id,
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(10) }],
    }),
  );
  return { location, user, variant };
}

const adjust = (input: AdjustmentInput, userId: string) =>
  db.$transaction((tx) => createAdjustment(tx, adjustmentInputSchema.parse(input), { id: userId }));
const onHand = async (variantId: string, locationId: string) =>
  (await db.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))
    ?.onHandMilli ?? 0;

describe("createAdjustment", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("posts ADJUSTMENT movements tied to the header and keeps the ledger consistent", async () => {
    const { location, user, variant } = await setup();
    const result = await adjust(
      {
        locationId: location.id,
        reason: "DAMAGED",
        note: null,
        lines: [{ mode: "delta", variantId: variant.id, qtyMilli: units(-3) }],
      },
      user.id,
    );
    expect(result.movementCount).toBe(1);
    expect(result.valueMongo).toBe(-fromMajor(3000));
    expect(await onHand(variant.id, location.id)).toBe(units(7));

    const movements = await db.stockMovement.findMany({
      where: { adjustmentId: result.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "ADJUSTMENT",
      qtyDeltaMilli: units(-3),
      balanceAfterMilli: units(7),
      unitCost: fromMajor(1000), // average-cost snapshot
      createdById: user.id,
    });
    expect(await findLedgerMismatches(db)).toEqual([]);
    expect(
      await db.auditLog.count({ where: { action: "stock.adjust", entityId: result.id } }),
    ).toBe(1);
  });

  it("supports 'set to' lines and refuses a direction the reason does not allow", async () => {
    const { location, user, variant } = await setup();
    // FOUND may only add: setting 10 -> 4 would remove stock.
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "FOUND",
          note: null,
          lines: [{ mode: "set", variantId: variant.id, qtyMilli: units(4) }],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.stockAdjustment.count()).toBe(0); // rolled back with the header
    expect(await onHand(variant.id, location.id)).toBe(units(10));

    const ok = await adjust(
      {
        locationId: location.id,
        reason: "CORRECTION",
        note: "Recount",
        lines: [{ mode: "set", variantId: variant.id, qtyMilli: units(12) }],
      },
      user.id,
    );
    expect(await onHand(variant.id, location.id)).toBe(units(12));
    const detail = await getAdjustment({ locationIds: "ALL" }, ok.id, true);
    expect(detail?.lines[0]).toMatchObject({
      qtyDeltaMilli: units(2),
      balanceAfterMilli: units(12),
    });
    expect(detail?.totalValue).toBe(fromMajor(2000));
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("never takes stock below zero and leaves nothing behind when it fails", async () => {
    const { location, user, variant } = await setup();
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "LOST_STOLEN",
          note: "Shoplifting",
          lines: [{ mode: "delta", variantId: variant.id, qtyMilli: units(-11) }],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await db.stockAdjustment.count()).toBe(0);
    expect(await db.stockMovement.count({ where: { type: "ADJUSTMENT" } })).toBe(0);
    expect(await onHand(variant.id, location.id)).toBe(units(10));
  });

  it("rejects a no-op 'set to', untracked products, and inactive locations", async () => {
    const { location, user, variant } = await setup();
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "CORRECTION",
          note: "same",
          lines: [{ mode: "set", variantId: variant.id, qtyMilli: units(10) }],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const { variant: service } = await createProduct({ trackStock: false });
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "FOUND",
          note: null,
          lines: [{ mode: "delta", variantId: service.id, qtyMilli: units(1) }],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    await db.location.update({ where: { id: location.id }, data: { isActive: false } });
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "FOUND",
          note: null,
          lines: [{ mode: "delta", variantId: variant.id, qtyMilli: units(1) }],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.stockAdjustment.count()).toBe(0);
  });

  it("keeps fractional units exact for weighed goods", async () => {
    const { location, user } = await setup();
    const { variant: kg } = await createProduct({ unit: "KG", cost: fromMajor(10_000) });
    await adjust(
      {
        locationId: location.id,
        reason: "FOUND",
        note: null,
        lines: [{ mode: "delta", variantId: kg.id, qtyMilli: 1250 }],
      },
      user.id,
    );
    expect(await onHand(kg.id, location.id)).toBe(1250);
    await expect(
      adjust(
        {
          locationId: location.id,
          reason: "OTHER",
          note: "piece fraction",
          lines: [
            {
              mode: "delta",
              variantId: (await createProduct()).variant.id,
              qtyMilli: 1500,
            },
          ],
        },
        user.id,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await findLedgerMismatches(db)).toEqual([]);
  });
});

describe("stock queries and scoping", () => {
  beforeEach(resetDatabase);

  it("limits permissions and data to the user's locations", async () => {
    const { location, user, variant } = await setup();
    const { location: other } = await createLocation({ name: "Other" });
    const cashier = await createUser({ role: "CASHIER", locationIds: [location.id] });
    const scoped = { role: user.role, locationIds: [location.id] };

    // Permission matrix used by the actions and pages.
    expect(can({ role: cashier.role, locationIds: [location.id] }, "inventory.adjust")).toBe(false);
    expect(can(scoped, "inventory.adjust", location.id)).toBe(true);
    expect(can(scoped, "inventory.adjust", other.id)).toBe(false);

    await db.$transaction((tx) =>
      postStockMovements(tx, {
        locationId: other.id,
        type: "OPENING",
        createdById: user.id,
        lines: [{ variantId: variant.id, qtyDeltaMilli: units(5) }],
      }),
    );
    await adjust(
      {
        locationId: other.id,
        reason: "DAMAGED",
        note: null,
        lines: [{ mode: "delta", variantId: variant.id, qtyMilli: units(-1) }],
      },
      user.id,
    );
    const mine = await adjust(
      {
        locationId: location.id,
        reason: "DAMAGED",
        note: null,
        lines: [{ mode: "delta", variantId: variant.id, qtyMilli: units(-1) }],
      },
      user.id,
    );

    const listed = await listAdjustments(scoped);
    expect(listed.rows.map((r) => r.id)).toEqual([mine.id]);
    expect((await listAdjustments(scoped, { locationId: other.id })).rows).toEqual([]);
    expect((await listAdjustments({ locationIds: "ALL" })).total).toBe(2);

    const foreign = await db.stockAdjustment.findFirstOrThrow({ where: { locationId: other.id } });
    expect(await getAdjustment(scoped, foreign.id, false)).toBeNull();
    expect(await getAdjustment(scoped, mine.id, false)).toMatchObject({ totalValue: null });

    expect((await listStock(scoped, { locationId: other.id, showCosts: false })).rows).toEqual([]);
    expect(
      (await listVariantLedger(scoped, variant.id, other.id, { showCosts: false })).rows,
    ).toEqual([]);
    const ledger = await listVariantLedger(scoped, variant.id, location.id, { showCosts: false });
    expect(ledger.rows.map((r) => r.type)).toEqual(["ADJUSTMENT", "OPENING"]); // newest first
    expect(ledger.rows.every((r) => r.unitCost === null)).toBe(true);
  });

  it("hides costs unless asked and lists low stock per accessible location", async () => {
    const { location, user, variant } = await setup();
    const { location: other } = await createLocation({ name: "Other" });
    await db.stockLevel.update({
      where: { variantId_locationId: { variantId: variant.id, locationId: location.id } },
      data: { reorderPointMilli: units(10) },
    });
    // A second location at its reorder point with nothing on hand.
    await db.stockLevel.create({
      data: { variantId: variant.id, locationId: other.id, onHandMilli: 0, reorderPointMilli: 0 },
    });
    // An item above its reorder point never shows.
    const { variant: plenty } = await createProduct();
    await db.stockLevel.create({
      data: {
        variantId: plenty.id,
        locationId: location.id,
        onHandMilli: units(50),
        reorderPointMilli: units(5),
      },
    });

    const scoped = { role: user.role, locationIds: [location.id] };
    const low = await listLowStock(scoped);
    expect(low.total).toBe(1);
    expect(low.items[0]).toMatchObject({ variantId: variant.id, locationId: location.id });
    expect((await listLowStock({ locationIds: "ALL" })).total).toBe(2);

    const hidden = await listStock(scoped, { locationId: location.id, showCosts: false });
    expect(hidden.rows.every((r) => r.avgCost === null && r.value === null)).toBe(true);
    const shown = await listStock(scoped, { locationId: location.id, showCosts: true });
    const row = shown.rows.find((r) => r.variantId === variant.id)!;
    expect(row.value).toBe(fromMajor(10_000)); // 10 pcs x 1,000
    const onlyLow = await listStock(scoped, {
      locationId: location.id,
      lowOnly: true,
      showCosts: false,
    });
    expect(onlyLow.rows.map((r) => r.variantId)).toEqual([variant.id]);
  });
});
