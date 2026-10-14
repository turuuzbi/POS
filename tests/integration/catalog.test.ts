import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  categoryInputSchema,
  productInputSchema,
  taxClassInputSchema,
  type ProductFormValues,
} from "@/domain/catalog";
import { units } from "@/domain/qty";
import {
  deleteCategory,
  deleteProduct,
  saveCategory,
  saveProduct,
  saveTaxClass,
  setTaxClassActive,
} from "@/server/services/catalog";
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

function input(overrides: Partial<ProductFormValues> = {}) {
  return productInputSchema.parse({
    name: "Цамц",
    type: "STANDARD",
    unit: "PIECE",
    categoryId: null,
    taxClassId,
    pricesIncludeTax: true,
    trackStock: true,
    options: [{ name: "Хэмжээ", values: ["S", "M"] }],
    variants: [
      { option1: "S", sku: "TS-S", price: "25,000", cost: "12,000", barcodes: ["8650001000015"] },
      { option1: "M", sku: "TS-M", price: "25,000", barcodes: [] },
    ],
    ...overrides,
  });
}

const save = (data: ReturnType<typeof input> & { id?: string }) =>
  db.$transaction((tx) => saveProduct(tx, data, actor));

describe("saveProduct", () => {
  it("creates a product with options, variants, barcodes and an audit record", async () => {
    const { id, variantIds } = await save(input());
    const product = await db.product.findUniqueOrThrow({
      where: { id },
      include: {
        options: true,
        variants: { include: { barcodes: true }, orderBy: { position: "asc" } },
      },
    });
    expect(product.options).toMatchObject([{ name: "Хэмжээ", position: 1, values: ["S", "M"] }]);
    expect(product.variants.map((v) => [v.sku, v.option1, v.price, v.cost])).toEqual([
      ["TS-S", "S", 2_500_000n, 1_200_000n],
      ["TS-M", "M", 2_500_000n, 0n],
    ]);
    expect(product.variants[0]!.barcodes.map((b) => b.code)).toEqual(["8650001000015"]);
    expect(variantIds).toEqual(product.variants.map((v) => v.id));
    expect(await db.auditLog.count({ where: { action: "product.create", entityId: id } })).toBe(1);
  });

  it("rejects codes another product already uses, naming the field", async () => {
    await save(input());
    await expect(
      save(
        input({
          name: "Өөр",
          options: [],
          variants: [{ sku: "ts-s", price: "1", barcodes: ["8650001000015"] }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fieldErrors: { "variants.0.sku": ["duplicate"], "variants.0.barcodes.0": ["duplicate"] },
    });
  });

  it("updates in place: codes may move between the product's own variants", async () => {
    const { id, variantIds } = await save(input());
    const [small, medium] = variantIds as [string, string];
    await save({
      ...input({
        variants: [
          { id: small, option1: "S", sku: "TS-M", price: "26,000", barcodes: [] },
          { id: medium, option1: "M", sku: "TS-S", price: "25,000", barcodes: ["8650001000015"] },
        ],
      }),
      id,
    });
    const variants = await db.productVariant.findMany({
      where: { productId: id },
      include: { barcodes: true },
      orderBy: { position: "asc" },
    });
    expect(variants.map((v) => [v.id, v.sku, v.price])).toEqual([
      [small, "TS-M", 2_600_000n],
      [medium, "TS-S", 2_500_000n],
    ]);
    expect(variants[1]!.barcodes.map((b) => b.code)).toEqual(["8650001000015"]);
    // Cost is kept (receiving maintains it), and the price change is audited.
    expect(variants[0]!.cost).toBe(1_200_000n);
    expect(await db.auditLog.count({ where: { action: "product.price_change" } })).toBe(1);
  });

  it("deletes a dropped variant without history but archives one with history", async () => {
    const { location } = await createLocation();
    const { id, variantIds } = await save(input());
    const [small, medium] = variantIds as [string, string];
    await db.$transaction((tx) =>
      postStockMovements(tx, {
        locationId: location.id,
        type: "OPENING",
        createdById: actor.id,
        lines: [{ variantId: small, qtyDeltaMilli: units(3) }],
      }),
    );
    await save({ ...input({ options: [], variants: [{ price: "1", barcodes: [] }] }), id });
    const variants = await db.productVariant.findMany({ where: { productId: id } });
    expect(variants.find((v) => v.id === medium)).toBeUndefined();
    expect(variants.find((v) => v.id === small)).toMatchObject({ isActive: false });
    expect(variants.filter((v) => v.isActive)).toHaveLength(1);
  });

  it("refuses inactive tax classes and categories", async () => {
    const category = await db.category.create({ data: { name: "Хуучин", isActive: false } });
    await expect(save(input({ categoryId: category.id }))).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { categoryId: ["inactive"] },
    });
  });
});

describe("deleteProduct", () => {
  it("deletes a product nobody used, and refuses one with history", async () => {
    const { location } = await createLocation();
    const unused = await save(input({ options: [], variants: [{ price: "1", barcodes: [] }] }));
    await db.$transaction((tx) => deleteProduct(tx, unused.id, actor));
    expect(await db.product.count({ where: { id: unused.id } })).toBe(0);

    const used = await save(input());
    await db.$transaction((tx) =>
      postStockMovements(tx, {
        locationId: location.id,
        type: "OPENING",
        createdById: actor.id,
        lines: [{ variantId: used.variantIds[0]!, qtyDeltaMilli: units(1) }],
      }),
    );
    await expect(db.$transaction((tx) => deleteProduct(tx, used.id, actor))).rejects.toMatchObject({
      code: "IN_USE",
    });
  });
});

describe("categories", () => {
  const category = (name: string, parentId: string | null = null) =>
    categoryInputSchema.parse({ name, parentId });

  it("refuses to make a category its own ancestor", async () => {
    const root = await db.$transaction((tx) => saveCategory(tx, category("Хүнс"), actor));
    const child = await db.$transaction((tx) => saveCategory(tx, category("Сүү", root.id), actor));
    await expect(
      db.$transaction((tx) =>
        saveCategory(tx, { ...category("Хүнс", child.id), id: root.id }, actor),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { parentId: ["cycle"] } });
  });

  it("deletes only unused categories", async () => {
    const root = await db.$transaction((tx) => saveCategory(tx, category("Хүнс"), actor));
    await db.$transaction((tx) => saveCategory(tx, category("Сүү", root.id), actor));
    await expect(db.$transaction((tx) => deleteCategory(tx, root.id, actor))).rejects.toMatchObject(
      {
        code: "IN_USE",
      },
    );
  });
});

describe("tax classes", () => {
  it("zeroes VAT for zero-rated and exempt classes, and protects the default", async () => {
    const parsed = taxClassInputSchema.parse({
      name: "Экспорт",
      treatment: "ZERO_RATED",
      vatRate: "10",
      cityTaxRate: "0",
    });
    const { id } = await db.$transaction((tx) => saveTaxClass(tx, parsed, actor));
    expect(await db.taxClass.findUniqueOrThrow({ where: { id } })).toMatchObject({ vatRateBps: 0 });

    await db.businessSettings.create({
      data: { businessName: "Дэлгүүр", defaultTaxClassId: taxClassId },
    });
    await expect(
      db.$transaction((tx) => setTaxClassActive(tx, taxClassId, false, actor)),
    ).rejects.toMatchObject({ code: "IN_USE" });
  });
});
