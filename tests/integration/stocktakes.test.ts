import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { units } from "@/domain/qty";
import type { ActionError } from "@/server/errors";
import {
  cancelStocktake,
  countLine,
  finalizeStocktake,
  scanItem,
  startStocktake,
} from "@/server/services/stocktakes";
import { findLedgerMismatches, postStockMovements } from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import { createLocation, createProduct, createUser } from "../support/fixtures";

async function setup() {
  const { location } = await createLocation();
  const user = await createUser({ role: "MANAGER", locationIds: [location.id] });
  return { location, user };
}

async function stock(locationId: string, userId: string, variantId: string, qtyMilli: number) {
  await db.$transaction((t) =>
    postStockMovements(t, {
      locationId,
      createdById: userId,
      type: "OPENING",
      lines: [{ variantId, qtyDeltaMilli: qtyMilli }],
    }),
  );
}

const onHand = async (variantId: string, locationId: string) =>
  (await db.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))
    ?.onHandMilli ?? 0;

const start = (
  locationId: string,
  user: { id: string },
  extra: { categoryId?: string | null } = {},
) => db.$transaction((t) => startStocktake(t, { locationId, ...extra }, user));
const count = (
  stocktakeId: string,
  variantId: string,
  mode: "set" | "add" | "clear",
  qtyMilli?: number,
) => db.$transaction((t) => countLine(t, { stocktakeId, variantId, mode, qtyMilli }));
const finalize = (id: string, user: { id: string }, countAll = false) =>
  db.$transaction((t) => finalizeStocktake(t, { id, countAll }, user));

describe("stocktakes", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("snapshots expected on-hand per line at start and scopes by category", async () => {
    const { location, user } = await setup();
    const parent = await db.category.create({ data: { name: "Drinks" } });
    const child = await db.category.create({ data: { name: "Juice", parentId: parent.id } });
    const other = await db.category.create({ data: { name: "Food" } });
    const a = await createProduct();
    const b = await createProduct();
    const c = await createProduct();
    const service = await createProduct({ trackStock: false });
    await db.product.update({ where: { id: a.product.id }, data: { categoryId: parent.id } });
    await db.product.update({ where: { id: b.product.id }, data: { categoryId: child.id } });
    await db.product.update({ where: { id: c.product.id }, data: { categoryId: other.id } });
    await stock(location.id, user.id, a.variant.id, units(4));
    await stock(location.id, user.id, b.variant.id, units(6));

    const full = await start(location.id, user);
    expect(full.number).toBe("ST-000001");
    expect(full.lineCount).toBe(3); // the untracked product is not counted
    const scoped = await start(location.id, user, { categoryId: parent.id });
    expect(scoped.number).toBe("ST-000002");
    const lines = await db.stocktakeLine.findMany({ where: { stocktakeId: scoped.id } });
    expect(lines.map((l) => [l.variantId, l.expectedMilli, l.countedMilli]).sort()).toEqual(
      [
        [a.variant.id, units(4), null],
        [b.variant.id, units(6), null],
      ].sort(),
    );
    expect(lines.some((l) => l.variantId === service.variant.id)).toBe(false);
  });

  it("finalize respects movements that happened during the count", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    await stock(location.id, user.id, variant.id, units(10));
    const st = await start(location.id, user);
    await count(st.id, variant.id, "set", units(8)); // shelf shows 8
    // A sale of 3 rings up while counting: the system now says 7.
    await db.$transaction((t) =>
      postStockMovements(t, {
        locationId: location.id,
        createdById: user.id,
        type: "SALE",
        lines: [{ variantId: variant.id, qtyDeltaMilli: units(-3) }],
      }),
    );
    const result = await finalize(st.id, user);
    expect(result.posted).toBe(1);
    // Variance is against the live balance (7 → 8 = +1), not the snapshot (10 → 8 = -2).
    const movement = await db.stockMovement.findFirstOrThrow({ where: { type: "STOCKTAKE" } });
    expect(movement.qtyDeltaMilli).toBe(units(1));
    expect(movement.balanceAfterMilli).toBe(units(8));
    expect(movement.stocktakeId).toBe(st.id);
    expect(await onHand(variant.id, location.id)).toBe(units(8));
    const line = await db.stocktakeLine.findFirstOrThrow({ where: { stocktakeId: st.id } });
    expect(line.expectedMilli).toBe(units(10));
    expect(line.varianceMilli).toBe(units(1));
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("a sale landing concurrently with finalize serialises on the stock lock", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    await stock(location.id, user.id, variant.id, units(10));
    const st = await start(location.id, user);
    await count(st.id, variant.id, "set", units(6));
    const sale = db.$transaction((t) =>
      postStockMovements(t, {
        locationId: location.id,
        createdById: user.id,
        type: "SALE",
        lines: [{ variantId: variant.id, qtyDeltaMilli: units(-1) }],
      }),
    );
    await Promise.all([finalize(st.id, user), sale]);
    // Whichever ran last, the count wins or the sale follows it; the chain stays unbroken.
    const ledger = await db.stockMovement.findMany({ orderBy: { seq: "asc" } });
    let running = 0;
    for (const m of ledger) {
      running += m.qtyDeltaMilli;
      expect(m.balanceAfterMilli).toBe(running);
    }
    expect([units(5), units(6)]).toContain(await onHand(variant.id, location.id));
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("only counted lines adjust stock unless 'count all' is chosen", async () => {
    const { location, user } = await setup();
    const a = await createProduct();
    const b = await createProduct();
    await stock(location.id, user.id, a.variant.id, units(5));
    await stock(location.id, user.id, b.variant.id, units(7));

    const partial = await start(location.id, user);
    await count(partial.id, a.variant.id, "set", units(4));
    const r1 = await finalize(partial.id, user);
    expect(r1).toEqual({ posted: 1, unchanged: 0, skippedUncounted: 1 });
    expect(await onHand(a.variant.id, location.id)).toBe(units(4));
    expect(await onHand(b.variant.id, location.id)).toBe(units(7));

    const all = await start(location.id, user);
    await count(all.id, a.variant.id, "set", units(4));
    const r2 = await finalize(all.id, user, true);
    expect(r2).toMatchObject({ posted: 1, skippedUncounted: 0 });
    expect(await onHand(b.variant.id, location.id)).toBe(0);
    const bLine = await db.stocktakeLine.findFirstOrThrow({
      where: { stocktakeId: all.id, variantId: b.variant.id },
    });
    expect(bLine.countedMilli).toBe(0);
    expect(bLine.varianceMilli).toBe(units(-7));
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("refuses to finalize twice, sequentially or concurrently", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    await stock(location.id, user.id, variant.id, units(10));
    const st = await start(location.id, user);
    await count(st.id, variant.id, "set", units(3));

    const settled = await Promise.allSettled([finalize(st.id, user), finalize(st.id, user)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ActionError).code).toBe("INVALID_STATE");
    await expect(finalize(st.id, user)).rejects.toMatchObject({ code: "INVALID_STATE" });

    expect(await db.stockMovement.count({ where: { type: "STOCKTAKE" } })).toBe(1);
    expect(await onHand(variant.id, location.id)).toBe(units(3));
    const done = await db.stocktake.findUniqueOrThrow({ where: { id: st.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.completedById).toBe(user.id);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("is immutable once completed or cancelled", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    const done = await start(location.id, user);
    await count(done.id, variant.id, "set", units(1));
    await finalize(done.id, user);
    await expect(count(done.id, variant.id, "set", units(2))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(db.$transaction((t) => cancelStocktake(t, done.id, user))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    const open = await start(location.id, user);
    await db.$transaction((t) => cancelStocktake(t, open.id, user));
    await expect(count(open.id, variant.id, "add", units(1))).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(finalize(open.id, user)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.stockMovement.count()).toBe(1); // only the first, completed count
  });

  it("adds scans atomically and validates quantities by unit", async () => {
    const { location, user } = await setup();
    const piece = await createProduct();
    const weighed = await createProduct({ unit: "KG" });
    const st = await start(location.id, user);

    await Promise.all(Array.from({ length: 6 }, () => count(st.id, piece.variant.id, "add", 1000)));
    const line = await db.stocktakeLine.findFirstOrThrow({
      where: { stocktakeId: st.id, variantId: piece.variant.id },
    });
    expect(line.countedMilli).toBe(units(6));

    await expect(count(st.id, piece.variant.id, "set", 1500)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(count(st.id, piece.variant.id, "add", 0)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const kg = await count(st.id, weighed.variant.id, "set", 1250);
    expect(kg.countedMilli).toBe(1250);
    expect((await count(st.id, weighed.variant.id, "clear")).countedMilli).toBeNull();
  });

  it("scan resolves a barcode: pieces count +1, weighed items ask for a quantity", async () => {
    const { location, user } = await setup();
    const piece = await createProduct();
    const weighed = await createProduct({ unit: "KG" });
    await db.barcode.create({ data: { code: "4600000000011", variantId: piece.variant.id } });
    await db.barcode.create({ data: { code: "2000000000029", variantId: weighed.variant.id } });
    const st = await start(location.id, user);

    const scan = (code: string) => db.$transaction((t) => scanItem(t, st.id, code));
    expect(await scan("4600000000011")).toMatchObject({ kind: "counted", countedMilli: units(1) });
    expect(await scan("4600000000011")).toMatchObject({ kind: "counted", countedMilli: units(2) });
    expect(await scan("2000000000029")).toMatchObject({ kind: "enter", countedMilli: null });
    expect(await scan("no-such-code")).toEqual({ kind: "none" });
  });

  it("an item scanned outside the snapshot gets a line with the current on-hand", async () => {
    const { location, user } = await setup();
    const st = await start(location.id, user);
    const late = await createProduct();
    await stock(location.id, user.id, late.variant.id, units(9));
    await count(st.id, late.variant.id, "set", units(9));
    const line = await db.stocktakeLine.findFirstOrThrow({ where: { stocktakeId: st.id } });
    expect(line.expectedMilli).toBe(units(9));
    const result = await finalize(st.id, user);
    expect(result).toMatchObject({ posted: 0, unchanged: 1 });
    expect(await db.stockMovement.count({ where: { type: "STOCKTAKE" } })).toBe(0);
  });
});
