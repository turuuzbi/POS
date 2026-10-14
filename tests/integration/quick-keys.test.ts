import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_QUICK_KEYS_PER_TAB } from "@/domain/quick-keys";
import type { ActionError } from "@/server/errors";
import {
  addQuickKey,
  removeQuickKey,
  reorderQuickKeys,
  setQuickKeyColor,
} from "@/server/services/quick-keys";
import { db, resetDatabase } from "../support/db";
import { createLocation, createProduct, createUser } from "../support/fixtures";

type Actor = Parameters<typeof addQuickKey>[2];

async function setup() {
  const { location } = await createLocation();
  const manager = await createUser({ role: "MANAGER", locationIds: [location.id] });
  const actor: Actor = { id: manager.id, role: "MANAGER", locationIds: [location.id] };
  return { location, manager, actor };
}

const add = (
  actor: Actor,
  locationId: string,
  productId: string,
  categoryId: string | null = null,
  color: string | null = null,
) => db.$transaction((tx) => addQuickKey(tx, { locationId, categoryId, productId, color }, actor));

const order = async (locationId: string, categoryId: string | null = null) =>
  (
    await db.quickKey.findMany({
      where: { locationId, categoryId },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    })
  ).map((k) => k.id);

const positions = async (locationId: string, categoryId: string | null = null) =>
  (
    await db.quickKey.findMany({
      where: { locationId, categoryId },
      orderBy: { position: "asc" },
      select: { position: true },
    })
  ).map((k) => k.position);

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as ActionError).code;
  }
  return null;
}

describe("quick keys", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("appends keys in order and audits each", async () => {
    const { location, actor } = await setup();
    const [a, b, c] = await Promise.all([createProduct(), createProduct(), createProduct()]);
    const k1 = await add(actor, location.id, a.product.id, null, "red");
    const k2 = await add(actor, location.id, b.product.id);
    const k3 = await add(actor, location.id, c.product.id);
    expect([k1.position, k2.position, k3.position]).toEqual([0, 1, 2]);
    expect(await order(location.id)).toEqual([k1.id, k2.id, k3.id]);
    expect((await db.quickKey.findUniqueOrThrow({ where: { id: k1.id } })).color).toBe("red");
    expect(await db.auditLog.count({ where: { action: "quickKey.add" } })).toBe(3);
  });

  it("refuses the same product twice on one tab but allows it on another tab or location", async () => {
    const { location, actor } = await setup();
    const other = await createLocation();
    const otherActor: Actor = { ...actor, locationIds: [location.id, other.location.id] };
    const category = await db.category.create({ data: { name: "Drinks" } });
    const { product } = await createProduct();
    await add(actor, location.id, product.id);
    expect(await code(add(actor, location.id, product.id))).toBe("CONFLICT");
    await add(actor, location.id, product.id, category.id);
    await add(otherActor, other.location.id, product.id);
    expect(await db.quickKey.count()).toBe(3);
  });

  it("serialises concurrent adds of the same product", async () => {
    const { location, actor } = await setup();
    const { product } = await createProduct();
    const results = await Promise.allSettled([
      add(actor, location.id, product.id),
      add(actor, location.id, product.id),
      add(actor, location.id, product.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.quickKey.count()).toBe(1);
  });

  it("caps keys per tab", async () => {
    const { location, actor } = await setup();
    const { product: first } = await createProduct();
    const category = await db.category.create({ data: { name: "Tab" } });
    const products = await Promise.all(
      Array.from({ length: MAX_QUICK_KEYS_PER_TAB }, () => createProduct()),
    );
    await db.quickKey.createMany({
      data: products.map((p, position) => ({
        locationId: location.id,
        categoryId: category.id,
        productId: p.product.id,
        position,
      })),
    });
    expect(await code(add(actor, location.id, first.id, category.id))).toBe("VALIDATION");
    // Another tab is unaffected.
    await add(actor, location.id, first.id);
  });

  it("rejects archived products, unknown products and inactive locations", async () => {
    const { location, actor } = await setup();
    const { product } = await createProduct();
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    expect(await code(add(actor, location.id, product.id))).toBe("VALIDATION");
    expect(await code(add(actor, location.id, crypto.randomUUID()))).toBe("NOT_FOUND");
    const { product: live } = await createProduct();
    expect(await code(add(actor, location.id, live.id, crypto.randomUUID()))).toBe("NOT_FOUND");
    await db.location.update({ where: { id: location.id }, data: { isActive: false } });
    expect(await code(add(actor, location.id, live.id))).toBe("NOT_FOUND");
  });

  it("reorders to the requested order and rejects stale or partial lists", async () => {
    const { location, actor } = await setup();
    const products = await Promise.all([createProduct(), createProduct(), createProduct()]);
    const keys: { id: string; position: number }[] = [];
    for (const p of products) keys.push(await add(actor, location.id, p.product.id));
    const [k1, k2, k3] = keys.map((k) => k.id) as [string, string, string];
    const reorder = (orderedIds: string[]) =>
      db.$transaction((tx) =>
        reorderQuickKeys(tx, { locationId: location.id, categoryId: null, orderedIds }, actor),
      );
    await reorder([k3, k1, k2]);
    expect(await order(location.id)).toEqual([k3, k1, k2]);
    expect(await positions(location.id)).toEqual([0, 1, 2]);
    expect(await code(reorder([k1, k2]))).toBe("CONFLICT");
    expect(await code(reorder([k1, k1, k2]))).toBe("CONFLICT");
    expect(await code(reorder([k1, k2, crypto.randomUUID()]))).toBe("CONFLICT");
    expect(await order(location.id)).toEqual([k3, k1, k2]);
    expect(await db.auditLog.count({ where: { action: "quickKey.reorder" } })).toBe(1);
  });

  it("closes the gap on remove and appends after the last key", async () => {
    const { location, actor } = await setup();
    const products = await Promise.all([createProduct(), createProduct(), createProduct()]);
    const keys: { id: string; position: number }[] = [];
    for (const p of products) keys.push(await add(actor, location.id, p.product.id));
    await db.$transaction((tx) => removeQuickKey(tx, { id: keys[0]!.id }, actor));
    expect(await positions(location.id)).toEqual([0, 1]);
    expect(await order(location.id)).toEqual([keys[1]!.id, keys[2]!.id]);
    const { product } = await createProduct();
    expect((await add(actor, location.id, product.id)).position).toBe(2);
    expect(
      await code(db.$transaction((tx) => removeQuickKey(tx, { id: keys[0]!.id }, actor))),
    ).toBe("NOT_FOUND");
    expect(await db.auditLog.count({ where: { action: "quickKey.remove" } })).toBe(1);
  });

  it("changes colour, audits it, and ignores a no-op", async () => {
    const { location, actor } = await setup();
    const { product } = await createProduct();
    const key = await add(actor, location.id, product.id, null, "blue");
    const set = (color: string | null) =>
      db.$transaction((tx) => setQuickKeyColor(tx, { id: key.id, color }, actor));
    await set("blue");
    expect(await db.auditLog.count({ where: { action: "quickKey.color" } })).toBe(0);
    await set(null);
    expect((await db.quickKey.findUniqueOrThrow({ where: { id: key.id } })).color).toBeNull();
    expect(await db.auditLog.count({ where: { action: "quickKey.color" } })).toBe(1);
  });

  it("scopes grids by location", async () => {
    const { location, actor } = await setup();
    const other = await createLocation();
    const otherManager = await createUser({ role: "MANAGER", locationIds: [other.location.id] });
    const otherActor: Actor = {
      id: otherManager.id,
      role: "MANAGER",
      locationIds: [other.location.id],
    };
    const p1 = await createProduct();
    const p2 = await createProduct();
    const mine = await add(actor, location.id, p1.product.id);
    const theirs = await add(otherActor, other.location.id, p2.product.id);
    // Positions are per grid, and one location's manager can't touch the other's grid.
    expect([mine.position, theirs.position]).toEqual([0, 0]);
    expect(await code(add(actor, other.location.id, p1.product.id))).toBe("FORBIDDEN");
    expect(await code(db.$transaction((tx) => removeQuickKey(tx, { id: theirs.id }, actor)))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(
        db.$transaction((tx) => setQuickKeyColor(tx, { id: theirs.id, color: "red" }, actor)),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        db.$transaction((tx) =>
          reorderQuickKeys(
            tx,
            { locationId: other.location.id, categoryId: null, orderedIds: [theirs.id] },
            actor,
          ),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(await db.quickKey.count()).toBe(2);
  });

  it("requires catalog.edit and leaves all-location keys alone", async () => {
    const { location } = await setup();
    const cashier = await createUser({ role: "CASHIER", locationIds: [location.id] });
    const cashierActor: Actor = { id: cashier.id, role: "CASHIER", locationIds: [location.id] };
    const owner: Actor = { id: cashier.id, role: "OWNER", locationIds: "ALL" };
    const { product } = await createProduct();
    expect(await code(add(cashierActor, location.id, product.id))).toBe("FORBIDDEN");
    const shared = await db.quickKey.create({
      data: { locationId: null, productId: product.id, position: 0 },
    });
    expect(await code(db.$transaction((tx) => removeQuickKey(tx, { id: shared.id }, owner)))).toBe(
      "NOT_FOUND",
    );
    const key = await add(owner, location.id, product.id);
    await db.$transaction((tx) => removeQuickKey(tx, { id: key.id }, owner));
    expect(await db.quickKey.count()).toBe(1);
  });
});
