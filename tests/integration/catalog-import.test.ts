import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseCatalogCsv } from "@/domain/csv-catalog";
import { catalogCsvChunks } from "@/server/queries/catalog-export";
import { commitCatalogImport, planCatalogImport } from "@/server/services/catalog-import";
import { db, resetDatabase } from "../support/db";
import { createProduct, createTaxClass, createUser } from "../support/fixtures";

let actor: { id: string };

beforeEach(async () => {
  await resetDatabase();
  actor = await createUser({ role: "MANAGER" });
  await db.taxClass.create({ data: { name: "НӨАТ 10%", vatRateBps: 1000 } });
});
afterAll(() => db.$disconnect());

const HEADER = "name,category,tax_class,option1_name,option1,sku,barcodes,price,cost,plu\r\n";
const commit = (csv: string, allowCost = true) =>
  db.$transaction((tx) => commitCatalogImport(tx, csv, actor, { allowCost }));
const plan = (csv: string, allowCost = true) => planCatalogImport(db, csv, { allowCost });

async function exportAll(withCosts: boolean) {
  let out = "";
  for await (const chunk of catalogCsvChunks(withCosts)) out += chunk;
  return out;
}

describe("catalog import", () => {
  it("dry run counts creates without writing", async () => {
    const result = await plan(
      `${HEADER}Талх,,НӨАТ 10%,,,TALH,8650001000015,2500,1500,\r\nЦамц,,НӨАТ 10%,Хэмжээ,S,TS-S,,25000,,\r\nЦамц,,,Хэмжээ,M,TS-M,,25000,,\r\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.items.map((i) => [i.action, i.input.variants.length])).toEqual([
      ["create", 1],
      ["create", 2],
    ]);
    expect(await db.product.count()).toBe(0);
  });

  it("creates products with variants, barcodes, cost and options in one go", async () => {
    const csv = `${HEADER}Талх,,НӨАТ 10%,,,TALH,8650001000015,"2,500.50",1500,\r\nЦамц,,,Хэмжээ,S,TS-S,,25000,12000,7\r\nЦамц,,,Хэмжээ,M,TS-M,,25000,,\r\n`;
    // the second product has no tax class: needs a default
    const settings = await db.taxClass.findFirstOrThrow();
    await db.businessSettings.upsert({
      where: { id: 1 },
      update: { defaultTaxClassId: settings.id },
      create: { id: 1, businessName: "Test", defaultTaxClassId: settings.id },
    });
    const outcome = await commit(csv);
    expect(outcome.committed).toBe(true);
    expect(outcome.preview).toMatchObject({ create: 2, update: 0, newVariants: 3 });

    const bread = await db.productVariant.findUniqueOrThrow({
      where: { sku: "TALH" },
      include: { barcodes: true },
    });
    expect(bread.price).toBe(250050n);
    expect(bread.cost).toBe(150000n);
    expect(bread.barcodes.map((b) => b.code)).toEqual(["8650001000015"]);
    const shirt = await db.product.findFirstOrThrow({
      where: { name: "Цамц" },
      include: { options: true, variants: { orderBy: { position: "asc" } } },
    });
    expect(shirt.options[0]).toMatchObject({ name: "Хэмжээ", values: ["S", "M"] });
    expect(shirt.variants.map((v) => v.option1)).toEqual(["S", "M"]);
    expect(shirt.variants[0]?.pluCode).toBe("7");
    expect(await db.auditLog.count({ where: { action: "catalog.import" } })).toBe(1);
  });

  it("updates by SKU, keeps blank cells and unlisted variants", async () => {
    const taxClass = await db.taxClass.findFirstOrThrow();
    const original = await createProduct({
      name: "Old",
      sku: "KEEP-1",
      price: 1000n,
      taxClassId: taxClass.id,
    });
    await db.productVariant.create({
      data: { productId: original.product.id, sku: "KEEP-2", price: 2000n, position: 1 },
    });
    const csv = `name,sku,price\r\nNew name,keep-1,50\r\n`;
    const result = await plan(csv);
    expect(result.issues).toEqual([]);
    expect(result.items[0]).toMatchObject({ action: "update", updatedVariants: 1, newVariants: 0 });
    expect((await commit(csv)).committed).toBe(true);

    const product = await db.product.findUniqueOrThrow({
      where: { id: original.product.id },
      include: { variants: { orderBy: { position: "asc" } } },
    });
    expect(product.name).toBe("New name");
    expect(product.taxClassId).toBe(taxClass.id);
    expect(product.variants.map((v) => [v.sku, v.price])).toEqual([
      ["KEEP-1", 5000n],
      ["KEEP-2", 2000n],
    ]);
  });

  it("updates by barcode and adds a new variant to the matched product", async () => {
    const created = await createProduct({ name: "Shirt", sku: "S-1", price: 1000n });
    await db.barcode.create({
      data: { code: "8650001000015", variantId: created.variant.id },
    });
    const csv = `name,sku,barcodes,price\r\nShirt,,8650001000015,20\r\nShirt,S-2,,30\r\n`;
    const outcome = await commit(csv);
    expect(outcome.committed).toBe(true);
    expect(outcome.preview).toMatchObject({
      update: 1,
      create: 0,
      newVariants: 1,
      updatedVariants: 1,
    });
    const variants = await db.productVariant.findMany({
      where: { productId: created.product.id },
      orderBy: { position: "asc" },
    });
    expect(variants.map((v) => [v.sku, v.price])).toEqual([
      ["S-1", 2000n],
      ["S-2", 3000n],
    ]);
    // the barcode was not dropped by the blank cell on other rows
    expect(await db.barcode.count({ where: { variantId: variants[0]!.id } })).toBe(1);
  });

  it("rejects rows matching two different products", async () => {
    await createProduct({ name: "A", sku: "A-1" });
    await createProduct({ name: "B", sku: "B-1" });
    const result = await plan(`name,sku,price\r\nX,A-1,1\r\nX,B-1,2\r\n`);
    expect(result.issues.map((i) => i.code)).toEqual(["ambiguousMatch", "ambiguousMatch"]);
  });

  it("rejects a SKU that matches one variant while the barcode belongs to another", async () => {
    await createProduct({ name: "A", sku: "A-1" });
    const b = await createProduct({ name: "B", sku: "B-1" });
    await db.barcode.create({ data: { code: "8650001000015", variantId: b.variant.id } });
    const result = await plan(`name,sku,barcodes,price\r\nA,A-1,8650001000015,1\r\n`);
    expect(result.issues).toEqual([{ line: 2, column: "sku", code: "ambiguousMatch" }]);
  });

  it("reports unknown references and schema errors with lines", async () => {
    const result = await plan(
      `name,category,tax_class,price,type,track_stock\r\nA,Nope,НӨАТ 10%,1,,\r\nB,,Missing,1,,\r\nC,,НӨАТ 10%,1,SERVICE,true\r\n`,
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { line: 2, column: "category", code: "unknownCategory" },
        { line: 3, column: "tax_class", code: "unknownTaxClass" },
        { line: 4, column: "track_stock", code: "invalid" },
      ]),
    );
  });

  it("requires a price for new variants and a tax class without a default", async () => {
    const result = await plan(`name,price\r\nA,\r\n`);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { line: 2, column: "price", code: "required" },
        { line: 2, column: "tax_class", code: "required" },
      ]),
    );
  });

  it("resolves categories by name and by path, and flags ambiguity", async () => {
    const parent = await db.category.create({ data: { name: "Хувцас" } });
    await db.category.create({ data: { name: "Эрэгтэй", parentId: parent.id } });
    const other = await db.category.create({ data: { name: "Бусад" } });
    await db.category.create({ data: { name: "Эрэгтэй", parentId: other.id } });
    const result = await plan(
      `name,category,tax_class,price\r\nA,Хувцас > Эрэгтэй,НӨАТ 10%,1\r\nB,Эрэгтэй,НӨАТ 10%,1\r\nC,Хувцас,НӨАТ 10%,1\r\n`,
    );
    expect(result.issues).toEqual([{ line: 3, column: "category", code: "ambiguousCategory" }]);
  });

  it("ignores nothing silently: archived tax classes and PLU clashes are errors", async () => {
    await db.taxClass.create({ data: { name: "Old", isActive: false } });
    const taken = await createProduct({ name: "P" });
    await db.productVariant.update({ where: { id: taken.variant.id }, data: { pluCode: "9" } });
    const result = await plan(`name,tax_class,price,plu\r\nA,Old,1,\r\nB,НӨАТ 10%,1,9\r\n`);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { line: 2, column: "tax_class", code: "inactive" },
        { line: 3, column: "plu", code: "duplicate" },
      ]),
    );
  });

  it("is all or nothing: an invalid file writes nothing", async () => {
    const outcome = await commit(`name,tax_class,price\r\nGood,НӨАТ 10%,1\r\nBad,НӨАТ 10%,x\r\n`);
    expect(outcome.committed).toBe(false);
    expect(outcome.preview.issueCount).toBe(1);
    expect(await db.product.count()).toBe(0);
  });

  it("rolls back every product when a later write fails", async () => {
    const csv = `name,tax_class,sku,price\r\nA,НӨАТ 10%,A-1,1\r\nB,НӨАТ 10%,B-1,1\r\n`;
    await expect(
      db.$transaction(async (tx) => {
        await commitCatalogImport(tx, csv, actor, { allowCost: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.product.count()).toBe(0);
  });

  it("refuses costs without the permission", async () => {
    const result = await plan(`name,tax_class,price,cost\r\nA,НӨАТ 10%,1,5\r\n`, false);
    expect(result.issues).toEqual([{ line: 2, column: "cost", code: "costNotAllowed" }]);
  });

  it("export then import is a no-op update", async () => {
    const tax = await createTaxClass({ name: "НӨАТ 5%", vatRateBps: 500 });
    const category = await db.category.create({ data: { name: "Хүнс" } });
    const item = await createProduct({
      name: '=Талх, "шинэ"',
      sku: "T-1",
      price: 123456n,
      cost: 5n,
      taxClassId: tax.id,
    });
    await db.product.update({ where: { id: item.product.id }, data: { categoryId: category.id } });
    await db.barcode.create({ data: { code: "8650001000015", variantId: item.variant.id } });

    const csv = await exportAll(true);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCatalogCsv(csv, { allowCost: true }).issues).toEqual([]);
    expect(csv).not.toContain(",=Талх");

    const result = await plan(csv);
    expect(result.issues).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.action).toBe("update");
    expect((await commit(csv)).committed).toBe(true);

    const after = await db.product.findUniqueOrThrow({
      where: { id: item.product.id },
      include: { variants: { include: { barcodes: true } } },
    });
    expect(after.name).toBe('=Талх, "шинэ"');
    expect(after.categoryId).toBe(category.id);
    expect(after.variants[0]).toMatchObject({ sku: "T-1", price: 123456n, cost: 5n });
    expect(after.variants[0]?.barcodes).toHaveLength(1);
    expect(await db.product.count()).toBe(1);
  });

  it("re-importing an unedited export creates nothing for variants without SKU or barcode", async () => {
    const tax = await db.taxClass.findFirstOrThrow();
    const shirt = await db.product.create({
      data: {
        name: "Shirt",
        taxClassId: tax.id,
        options: { create: { name: "Size", position: 0, values: ["S", "M"] } },
        variants: {
          create: [
            { option1: "S", price: 1000n, position: 0 },
            { option1: "M", price: 1200n, position: 1 },
            { option1: "L", price: 1300n, sku: "SH-L", position: 2 },
          ],
        },
      },
    });
    const plain = await db.product.create({
      data: { name: "Plain", taxClassId: tax.id, variants: { create: { price: 500n } } },
    });
    const csv = await exportAll(true);
    const result = await plan(csv);
    expect(result.issues).toEqual([]);
    expect(result.items.map((i) => [i.action, i.newVariants].join(":")).sort()).toEqual([
      "update:0",
      "update:0",
    ]);
    expect((await commit(csv)).committed).toBe(true);
    expect(await db.product.count()).toBe(2);
    expect(await db.productVariant.count({ where: { productId: shirt.id } })).toBe(3);
    expect(await db.productVariant.count({ where: { productId: plain.id } })).toBe(1);
  });

  it("export hides cost for users without the permission", async () => {
    await createProduct({ name: "P", cost: 777n });
    const csv = await exportAll(false);
    expect(csv.split("\r\n")[0]).not.toContain("cost");
    expect(csv).not.toContain("7.77");
  });

  it("export covers more than one batch", async () => {
    const tax = await createTaxClass();
    await db.product.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({ name: `P${i}`, taxClassId: tax.id })),
    });
    const products = await db.product.findMany({ select: { id: true } });
    await db.productVariant.createMany({
      data: products.map((p, i) => ({ productId: p.id, price: 100n, sku: `S${i}` })),
    });
    const csv = await exportAll(false);
    expect(parseCatalogCsv(csv).rows).toHaveLength(450);
  });
});
