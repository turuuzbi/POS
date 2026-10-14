import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { productInputSchema } from "@/domain/catalog";
import { IMAGE_MAX_BYTES } from "@/domain/product-form";
import { units } from "@/domain/qty";
import type { StorageProvider } from "@/server/adapters/storage";
import { getProductForEdit, listProducts, productFormOptions } from "@/server/queries/products";
import { saveProduct, setProductActive } from "@/server/services/catalog";
import { removeProductImage, setProductImage } from "@/server/services/product-images";
import { postStockMovements } from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import { createLocation, createTaxClass, createUser } from "../support/fixtures";

let actor: { id: string };
let taxClassId: string;

beforeEach(async () => {
  await resetDatabase();
  actor = await createUser({ role: "MANAGER" });
  taxClassId = (await createTaxClass()).id;
});
afterAll(() => db.$disconnect());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function memoryStorage() {
  const files = new Map<string, string>();
  const storage: StorageProvider = {
    name: "local",
    async put(key, _body, contentType) {
      files.set(`/mem/${key}`, contentType);
      return `/mem/${key}`;
    },
    async delete(url) {
      files.delete(url);
    },
  };
  return { storage, files };
}

async function create(name: string, extra: Record<string, unknown> = {}) {
  const input = productInputSchema.parse({
    name,
    type: "STANDARD",
    unit: "PIECE",
    categoryId: null,
    taxClassId,
    pricesIncludeTax: true,
    trackStock: true,
    options: [],
    variants: [{ sku: `SKU-${name}`, price: "1,000", barcodes: [`BC-${name}-0001`] }],
    ...extra,
  });
  return db.$transaction((tx) => saveProduct(tx, input, actor));
}

describe("product images", () => {
  it("stores one image, replaces and removes it, deleting the old file", async () => {
    const { id } = await create("Tea");
    const { storage, files } = memoryStorage();

    const first = await db.$transaction((tx) => setProductImage(tx, id, PNG, actor, {}, storage));
    expect(first.imageUrl).toMatch(/^\/mem\/products\/[0-9a-f-]{36}\.png$/);
    expect(files.get(first.imageUrl)).toBe("image/png");
    expect((await db.product.findUniqueOrThrow({ where: { id } })).imageUrl).toBe(first.imageUrl);

    const second = await db.$transaction((tx) => setProductImage(tx, id, PNG, actor, {}, storage));
    expect(second.imageUrl).not.toBe(first.imageUrl);
    expect([...files.keys()]).toEqual([second.imageUrl]);

    await db.$transaction((tx) => removeProductImage(tx, id, actor, {}, storage));
    expect(files.size).toBe(0);
    expect((await db.product.findUniqueOrThrow({ where: { id } })).imageUrl).toBeNull();

    const actions = await db.auditLog.findMany({
      where: { entityId: id, action: { startsWith: "product.image" } },
    });
    expect(actions).toHaveLength(3);
  });

  it("rejects oversize files, non-images and disguised content without storing anything", async () => {
    const { id } = await create("Coffee");
    const { storage, files } = memoryStorage();
    const run = (bytes: Uint8Array) =>
      db.$transaction((tx) => setProductImage(tx, id, bytes, actor, {}, storage));

    await expect(run(new Uint8Array(0))).rejects.toMatchObject({
      fieldErrors: { file: ["required"] },
    });
    const huge = new Uint8Array(IMAGE_MAX_BYTES + 1);
    huge.set(PNG);
    await expect(run(huge)).rejects.toMatchObject({ fieldErrors: { file: ["tooLong"] } });
    await expect(run(new TextEncoder().encode("<svg onload=alert(1)>"))).rejects.toMatchObject({
      fieldErrors: { file: ["invalid"] },
    });
    expect(files.size).toBe(0);
  });

  it("reports NOT_FOUND for a missing product", async () => {
    const { storage } = memoryStorage();
    await expect(
      db.$transaction((tx) =>
        setProductImage(tx, "00000000-0000-7000-8000-000000000000", PNG, actor, {}, storage),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listProducts", () => {
  it("shows on-hand per accessible location only", async () => {
    const a = await createLocation({ name: "A" });
    const b = await createLocation({ name: "B" });
    const { id, variantIds } = await create("Rice");
    for (const [loc, qty] of [
      [a.location.id, 3],
      [b.location.id, 7],
    ] as const) {
      await db.$transaction((tx) =>
        postStockMovements(tx, {
          locationId: loc,
          type: "OPENING",
          createdById: actor.id,
          lines: [{ variantId: variantIds[0]!, qtyDeltaMilli: units(qty) }],
        }),
      );
    }

    const all = await listProducts({}, { locationIds: "ALL" });
    expect(all.locations).toHaveLength(2);
    expect(all.rows[0]!.onHand).toEqual({
      [a.location.id]: units(3),
      [b.location.id]: units(7),
    });

    const scoped = await listProducts({}, { locationIds: [b.location.id] });
    expect(scoped.locations.map((l) => l.id)).toEqual([b.location.id]);
    expect(scoped.rows[0]!.onHand).toEqual({ [b.location.id]: units(7) });

    const edit = await getProductForEdit(id, { locationIds: [a.location.id] });
    expect(edit!.onHand[variantIds[0]!]).toBe(units(3));
  });

  it("filters by search (name, SKU, barcode, PLU), category and status, and paginates", async () => {
    const category = await db.category.create({ data: { name: "Drinks" } });
    const child = await db.category.create({ data: { name: "Tea", parentId: category.id } });
    await create("Green tea", {
      categoryId: child.id,
      variants: [{ price: "1", pluCode: "00042" }],
    });
    const coffee = await create("Coffee");
    await create("Plain");
    await db.$transaction((tx) => setProductActive(tx, coffee.id, false, actor));

    const scope = { locationIds: "ALL" } as const;
    const names = async (filters: Parameters<typeof listProducts>[0]) =>
      (await listProducts(filters, scope)).rows.map((r) => r.name);

    expect(await names({})).toEqual(["Green tea", "Plain"]);
    expect(await names({ status: "archived" })).toEqual(["Coffee"]);
    expect(await names({ status: "all" })).toEqual(["Coffee", "Green tea", "Plain"]);
    expect(await names({ q: "GREEN" })).toEqual(["Green tea"]);
    expect(await names({ q: "SKU-Plain" })).toEqual(["Plain"]);
    expect(await names({ q: "BC-Plain-0001" })).toEqual(["Plain"]);
    expect(await names({ q: "42" })).toEqual(["Green tea"]);
    expect(await names({ categoryId: category.id })).toEqual(["Green tea"]); // includes subcategories
    expect(await names({ q: "zzz" })).toEqual([]);

    const result = await listProducts({ status: "all", page: 9 }, scope);
    expect(result.total).toBe(3);
    expect(result.rows).toEqual([]);
  });

  it("includes archived references the product already uses in the form options", async () => {
    const inactive = await db.taxClass.create({ data: { name: "Old", isActive: false } });
    expect((await productFormOptions()).taxClasses.map((t) => t.id)).not.toContain(inactive.id);
    expect(
      (await productFormOptions({ taxClassId: inactive.id })).taxClasses.map((t) => t.id),
    ).toContain(inactive.id);
  });
});
