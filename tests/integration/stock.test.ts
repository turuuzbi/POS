import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fromMajor } from "@/domain/money";
import { units } from "@/domain/qty";
import { ActionError } from "@/server/errors";
import { nextDocumentNumber } from "@/server/services/sequence";
import {
  findLedgerMismatches,
  postStockMovements,
  rebuildStockLevels,
  type PostStockInput,
} from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import { createLocation, createProduct, createUser } from "../support/fixtures";

async function setup() {
  const { location } = await createLocation();
  const user = await createUser({ role: "MANAGER", locationIds: [location.id] });
  return { location, user };
}

const post = (input: PostStockInput) => db.$transaction((tx) => postStockMovements(tx, input));
const onHand = async (variantId: string, locationId: string) =>
  (await db.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))
    ?.onHandMilli ?? 0;

describe("postStockMovements", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("moves stock, records running balances and keeps the cache equal to the ledger", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    const base = { locationId: location.id, createdById: user.id };
    await post({
      ...base,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(10) }],
    });
    const posted = await post({
      ...base,
      type: "ADJUSTMENT",
      lines: [
        { variantId: variant.id, qtyDeltaMilli: units(-3) },
        { variantId: variant.id, qtyDeltaMilli: units(-2) },
      ],
    });
    expect(posted.map((p) => [p.balanceBeforeMilli, p.balanceAfterMilli])).toEqual([
      [units(10), units(7)],
      [units(7), units(5)],
    ]);
    expect(await onHand(variant.id, location.id)).toBe(units(5));
    const ledger = await db.stockMovement.findMany({ orderBy: { seq: "asc" } });
    expect(ledger.map((m) => m.balanceAfterMilli)).toEqual([units(10), units(7), units(5)]);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("serialises concurrent writers: no lost updates, an unbroken balance chain", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct({ unit: "KG" });
    const base = { locationId: location.id, createdById: user.id };
    await post({
      ...base,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: 5000 }],
    });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        post({
          ...base,
          type: "ADJUSTMENT",
          lines: [{ variantId: variant.id, qtyDeltaMilli: i % 5 === 0 ? 1250 : -250 }],
        }),
      ),
    );
    // 5 × +1.250 kg, 20 × −0.250 kg
    expect(await onHand(variant.id, location.id)).toBe(5000 + 5 * 1250 - 20 * 250);
    const ledger = await db.stockMovement.findMany({
      where: { variantId: variant.id },
      orderBy: { seq: "asc" },
    });
    let running = 0;
    for (const movement of ledger) {
      running += movement.qtyDeltaMilli;
      expect(movement.balanceAfterMilli).toBe(running);
    }
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("never deadlocks when concurrent writers touch the same items in different orders", async () => {
    const { location, user } = await setup();
    const a = (await createProduct()).variant;
    const b = (await createProduct()).variant;
    const base = { locationId: location.id, createdById: user.id, type: "ADJUSTMENT" as const };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post({
          ...base,
          lines:
            i % 2
              ? [
                  { variantId: a.id, qtyDeltaMilli: units(1) },
                  { variantId: b.id, qtyDeltaMilli: units(1) },
                ]
              : [
                  { variantId: b.id, qtyDeltaMilli: units(1) },
                  { variantId: a.id, qtyDeltaMilli: units(1) },
                ],
        }),
      ),
    );
    expect(await onHand(a.id, location.id)).toBe(units(20));
    expect(await onHand(b.id, location.id)).toBe(units(20));
  });

  it("refuses to go negative when told to, and writes nothing", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    const base = { locationId: location.id, createdById: user.id };
    await post({
      ...base,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(2) }],
    });
    await expect(
      post({
        ...base,
        type: "ADJUSTMENT",
        forbidNegative: true,
        lines: [{ variantId: variant.id, qtyDeltaMilli: units(-3) }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await onHand(variant.id, location.id)).toBe(units(2));
    expect(await db.stockMovement.count()).toBe(1);
    // Allowed by default (selling into negative stock is a setting).
    await post({
      ...base,
      type: "ADJUSTMENT",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(-3) }],
    });
    expect(await onHand(variant.id, location.id)).toBe(units(-1));
  });

  it("sets counted stock: computes the variance under the lock and skips exact matches", async () => {
    const { location, user } = await setup();
    const a = (await createProduct()).variant;
    const b = (await createProduct()).variant;
    const base = { locationId: location.id, createdById: user.id };
    await post({
      ...base,
      type: "OPENING",
      lines: [
        { variantId: a.id, qtyDeltaMilli: units(10) },
        { variantId: b.id, qtyDeltaMilli: units(4) },
      ],
    });
    const posted = await post({
      ...base,
      type: "STOCKTAKE",
      lines: [
        { variantId: a.id, countedMilli: units(7) },
        { variantId: b.id, countedMilli: units(4) },
      ],
    });
    expect(posted).toMatchObject([
      { variantId: a.id, qtyDeltaMilli: units(-3), balanceAfterMilli: units(7) },
      { variantId: b.id, qtyDeltaMilli: 0, movementId: null },
    ]);
    expect(await db.stockMovement.count({ where: { type: "STOCKTAKE" } })).toBe(1);
  });

  it("updates the business-wide moving-average cost on receipts", async () => {
    const { location, user } = await setup();
    const { location: other } = await createLocation();
    const { variant } = await createProduct({ cost: fromMajor(1000) });
    await post({
      locationId: other.id,
      createdById: user.id,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(10) }],
    });
    // 10 pcs at 1,000₮ elsewhere + 30 received here at 2,000₮ → 1,750₮
    const [line] = await post({
      locationId: location.id,
      createdById: user.id,
      type: "PURCHASE_RECEIPT",
      updateAverageCost: true,
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(30), unitCost: fromMajor(2000) }],
    });
    const updated = await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(updated.cost).toBe(fromMajor(1750));
    const movement = await db.stockMovement.findUniqueOrThrow({ where: { id: line!.movementId! } });
    expect(movement.unitCost).toBe(fromMajor(2000));
  });

  it("snapshots the average cost on other movements", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct({ cost: fromMajor(1234) });
    const [line] = await post({
      locationId: location.id,
      createdById: user.id,
      type: "ADJUSTMENT",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(-1) }],
    });
    const movement = await db.stockMovement.findUniqueOrThrow({ where: { id: line!.movementId! } });
    expect(movement.unitCost).toBe(fromMajor(1234));
  });

  it("rejects untracked products, fractional pieces and unknown variants", async () => {
    const { location, user } = await setup();
    const service = (await createProduct({ type: "SERVICE", trackStock: false })).variant;
    const piece = (await createProduct({ unit: "PIECE" })).variant;
    const base = { locationId: location.id, createdById: user.id, type: "ADJUSTMENT" as const };
    await expect(
      post({ ...base, lines: [{ variantId: service.id, qtyDeltaMilli: units(1) }] }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      post({ ...base, lines: [{ variantId: piece.id, qtyDeltaMilli: 500 }] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      post({ ...base, lines: [{ variantId: piece.id, qtyDeltaMilli: 0 }] }),
    ).rejects.toBeInstanceOf(ActionError);
    await expect(
      post({
        ...base,
        lines: [{ variantId: "0190a000-0000-7000-8000-00000000dead", qtyDeltaMilli: units(1) }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("ledger verification", () => {
  beforeEach(resetDatabase);

  it("finds a drifted cache and rebuilds it from the ledger", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct();
    const orphan = (await createProduct()).variant;
    await post({
      locationId: location.id,
      createdById: user.id,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(8) }],
    });
    await db.stockLevel.update({
      where: { variantId_locationId: { variantId: variant.id, locationId: location.id } },
      data: { onHandMilli: units(99) },
    });
    await db.stockLevel.create({
      data: { variantId: orphan.id, locationId: location.id, onHandMilli: units(3) },
    });
    const mismatches = await findLedgerMismatches(db);
    expect(mismatches).toHaveLength(2);
    expect(mismatches).toContainEqual({
      variantId: variant.id,
      locationId: location.id,
      cachedMilli: units(99),
      ledgerMilli: units(8),
      lastBalanceMilli: units(8),
    });
    expect(await rebuildStockLevels(db)).toBe(2);
    expect(await findLedgerMismatches(db)).toEqual([]);
    expect(await onHand(variant.id, location.id)).toBe(units(8));
    expect(await onHand(orphan.id, location.id)).toBe(0);
  });
});

describe("document numbers", () => {
  beforeEach(resetDatabase);

  it("are gap-free and unique under concurrency, and a rollback returns its number", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await nextDocumentNumber(tx, "purchaseOrder");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.$transaction((tx) => nextDocumentNumber(tx, "purchaseOrder")),
      ),
    );
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `PO-${String(i + 1).padStart(6, "0")}`),
    );
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "goodsReceipt"))).toBe("GR-000001");
  });

  it("two parallel receipts of one variant fold into an exact weighted average cost", async () => {
    const { location, user } = await setup();
    const { variant } = await createProduct({ cost: 0n });
    const base = { locationId: location.id, createdById: user.id } as const;
    await post({
      ...base,
      type: "OPENING",
      lines: [{ variantId: variant.id, qtyDeltaMilli: units(10), unitCost: 1000n }],
      updateAverageCost: true,
    });
    const receipt = () =>
      post({
        ...base,
        type: "PURCHASE_RECEIPT",
        lines: [{ variantId: variant.id, qtyDeltaMilli: units(10), unitCost: 2000n }],
        updateAverageCost: true,
      });
    await Promise.all([receipt(), receipt()]);
    // (10@1000 + 10@2000 + 10@2000) / 30 = 1666.67 -> a lost update would give 1500.
    const cost = (await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).cost;
    expect(cost).toBe(1667n);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });
});
