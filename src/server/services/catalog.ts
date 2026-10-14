import "server-only";
import type { CategoryInput, ProductInput, TaxClassInput } from "@/domain/catalog";
import { audit } from "../audit";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";

/**
 * Catalog writes. Every function runs inside the caller's transaction and
 * writes its audit record there too. Products and variants that have any
 * history (stock, sales, purchasing) are archived, never deleted.
 */

export interface Actor {
  id: string;
}

type Meta = Partial<RequestMeta>;

function conflict(fieldErrors: Record<string, string[]>): never {
  throw new ActionError("CONFLICT", "duplicate catalog codes", fieldErrors);
}

// ── Categories ────────────────────────────────────────────────────────────

async function assertNoCycle(tx: Tx, id: string, parentId: string | null): Promise<void> {
  for (let current = parentId, depth = 0; current; depth++) {
    if (current === id || depth > 50) {
      throw new ActionError("VALIDATION", "category cycle", { parentId: ["cycle"] });
    }
    const parent = await tx.category.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = parent?.parentId ?? null;
  }
}

export async function saveCategory(
  tx: Tx,
  input: CategoryInput & { id?: string },
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string }> {
  if (input.parentId) {
    const parent = await tx.category.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new ActionError("NOT_FOUND");
    if (!parent.isActive) {
      throw new ActionError("VALIDATION", "inactive parent", { parentId: ["inactive"] });
    }
  }
  const data = {
    name: input.name,
    parentId: input.parentId,
    color: input.color,
    sortOrder: input.sortOrder,
  };
  if (input.id) {
    const before = await tx.category.findUnique({ where: { id: input.id } });
    if (!before) throw new ActionError("NOT_FOUND");
    await assertNoCycle(tx, input.id, input.parentId);
    await tx.category.update({ where: { id: input.id }, data });
    await audit(tx, {
      actorId: actor.id,
      action: "category.update",
      entityType: "Category",
      entityId: input.id,
      before: { name: before.name, parentId: before.parentId },
      after: { name: input.name, parentId: input.parentId },
      ...meta,
    });
    return { id: input.id };
  }
  const created = await tx.category.create({ data });
  await audit(tx, {
    actorId: actor.id,
    action: "category.create",
    entityType: "Category",
    entityId: created.id,
    after: { name: input.name, parentId: input.parentId },
    ...meta,
  });
  return { id: created.id };
}

export async function setCategoryActive(
  tx: Tx,
  id: string,
  isActive: boolean,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const { count } = await tx.category.updateMany({ where: { id }, data: { isActive } });
  if (count === 0) throw new ActionError("NOT_FOUND");
  await audit(tx, {
    actorId: actor.id,
    action: isActive ? "category.restore" : "category.archive",
    entityType: "Category",
    entityId: id,
    ...meta,
  });
}

/** Delete an unused category (no products, no subcategories); otherwise IN_USE. */
export async function deleteCategory(
  tx: Tx,
  id: string,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const category = await tx.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true, children: true, stocktakes: true } } },
  });
  if (!category) throw new ActionError("NOT_FOUND");
  const { products, children, stocktakes } = category._count;
  if (products + children + stocktakes > 0) throw new ActionError("IN_USE");
  await tx.category.delete({ where: { id } });
  await audit(tx, {
    actorId: actor.id,
    action: "category.delete",
    entityType: "Category",
    entityId: id,
    before: { name: category.name },
    ...meta,
  });
}

// ── Tax classes ───────────────────────────────────────────────────────────

export async function saveTaxClass(
  tx: Tx,
  input: TaxClassInput & { id?: string },
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string }> {
  const data = {
    name: input.name,
    treatment: input.treatment,
    // Zero-rated and exempt goods carry no VAT, whatever was typed.
    vatRateBps: input.treatment === "STANDARD" ? input.vatRate : 0,
    cityTaxRateBps: input.cityTaxRate,
  };
  if (input.id) {
    const before = await tx.taxClass.findUnique({ where: { id: input.id } });
    if (!before) throw new ActionError("NOT_FOUND");
    await tx.taxClass.update({ where: { id: input.id }, data });
    await audit(tx, {
      actorId: actor.id,
      action: "tax_class.update",
      entityType: "TaxClass",
      entityId: input.id,
      before: {
        name: before.name,
        treatment: before.treatment,
        vatRateBps: before.vatRateBps,
        cityTaxRateBps: before.cityTaxRateBps,
      },
      after: data,
      ...meta,
    });
    return { id: input.id };
  }
  const created = await tx.taxClass.create({ data });
  await audit(tx, {
    actorId: actor.id,
    action: "tax_class.create",
    entityType: "TaxClass",
    entityId: created.id,
    after: data,
    ...meta,
  });
  return { id: created.id };
}

export async function setTaxClassActive(
  tx: Tx,
  id: string,
  isActive: boolean,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  if (!isActive) {
    const settings = await tx.businessSettings.findUnique({ where: { id: 1 } });
    if (settings?.defaultTaxClassId === id) throw new ActionError("IN_USE");
  }
  const { count } = await tx.taxClass.updateMany({ where: { id }, data: { isActive } });
  if (count === 0) throw new ActionError("NOT_FOUND");
  await audit(tx, {
    actorId: actor.id,
    action: isActive ? "tax_class.restore" : "tax_class.archive",
    entityType: "TaxClass",
    entityId: id,
    ...meta,
  });
}

// ── Products ──────────────────────────────────────────────────────────────

/**
 * Codes must be unique across the catalog: SKU and PLU per variant, barcode
 * per code. Reports clashes with other products as field errors on the
 * offending input paths.
 */
async function assertCodesAvailable(tx: Tx, input: ProductInput, productId: string | null) {
  const skus = input.variants.flatMap((v) => (v.sku ? [v.sku] : []));
  const plus = input.variants.flatMap((v) => (v.pluCode ? [v.pluCode] : []));
  const codes = input.variants.flatMap((v) => v.barcodes);
  const notThisProduct = productId ? { productId: { not: productId } } : {};
  const [skuHits, pluHits, barcodeHits] = await Promise.all([
    skus.length
      ? tx.productVariant.findMany({
          where: { sku: { in: skus, mode: "insensitive" }, ...notThisProduct },
          select: { sku: true },
        })
      : [],
    plus.length
      ? tx.productVariant.findMany({
          where: { pluCode: { in: plus }, ...notThisProduct },
          select: { pluCode: true },
        })
      : [],
    codes.length
      ? tx.barcode.findMany({
          where: {
            code: { in: codes },
            ...(productId ? { variant: { productId: { not: productId } } } : {}),
          },
          select: { code: true },
        })
      : [],
  ]);
  const takenSku = new Set(skuHits.map((h) => h.sku!.toLowerCase()));
  const takenPlu = new Set(pluHits.map((h) => h.pluCode));
  const takenCode = new Set(barcodeHits.map((h) => h.code));
  const errors: Record<string, string[]> = {};
  input.variants.forEach((variant, index) => {
    if (variant.sku && takenSku.has(variant.sku.toLowerCase())) {
      errors[`variants.${index}.sku`] = ["duplicate"];
    }
    if (variant.pluCode && takenPlu.has(variant.pluCode)) {
      errors[`variants.${index}.pluCode`] = ["duplicate"];
    }
    variant.barcodes.forEach((code, b) => {
      if (takenCode.has(code)) errors[`variants.${index}.barcodes.${b}`] = ["duplicate"];
    });
  });
  if (Object.keys(errors).length > 0) conflict(errors);
}

async function assertReferences(tx: Tx, input: ProductInput) {
  const [taxClass, category] = await Promise.all([
    tx.taxClass.findUnique({ where: { id: input.taxClassId } }),
    input.categoryId ? tx.category.findUnique({ where: { id: input.categoryId } }) : null,
  ]);
  if (!taxClass || (input.categoryId && !category)) throw new ActionError("NOT_FOUND");
  const errors: Record<string, string[]> = {};
  if (!taxClass.isActive) errors.taxClassId = ["inactive"];
  if (category && !category.isActive) errors.categoryId = ["inactive"];
  if (Object.keys(errors).length > 0) {
    throw new ActionError("VALIDATION", "inactive reference", errors);
  }
}

function variantData(variant: ProductInput["variants"][number], position: number) {
  return {
    name: variant.name,
    sku: variant.sku,
    pluCode: variant.pluCode,
    option1: variant.option1,
    option2: variant.option2,
    option3: variant.option3,
    price: variant.price,
    isActive: variant.isActive,
    position,
  };
}

function productData(input: ProductInput) {
  return {
    name: input.name,
    description: input.description,
    type: input.type,
    unit: input.unit,
    categoryId: input.categoryId,
    taxClassId: input.taxClassId,
    pricesIncludeTax: input.pricesIncludeTax,
    trackStock: input.trackStock,
    taxClassificationCode: input.taxClassificationCode,
    isActive: input.isActive,
  };
}

/** Create or update a product with its options, variants and barcodes. */
export async function saveProduct(
  tx: Tx,
  input: ProductInput & { id?: string },
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string; variantIds: string[] }> {
  await assertReferences(tx, input);
  await assertCodesAvailable(tx, input, input.id ?? null);
  return input.id
    ? updateProduct(tx, { ...input, id: input.id }, actor, meta)
    : createProduct(tx, input, actor, meta);
}

async function createProduct(tx: Tx, input: ProductInput, actor: Actor, meta: Meta) {
  const product = await tx.product.create({
    data: {
      ...productData(input),
      options: {
        create: input.options.map((option, index) => ({
          name: option.name,
          position: index + 1,
          values: option.values,
        })),
      },
    },
  });
  const variantIds: string[] = [];
  for (const [position, variant] of input.variants.entries()) {
    const created = await tx.productVariant.create({
      data: {
        ...variantData(variant, position),
        productId: product.id,
        cost: variant.cost ?? 0n,
        barcodes: { create: variant.barcodes.map((code) => ({ code })) },
      },
    });
    variantIds.push(created.id);
  }
  await audit(tx, {
    actorId: actor.id,
    action: "product.create",
    entityType: "Product",
    entityId: product.id,
    after: {
      name: input.name,
      variants: input.variants.map((v) => ({ sku: v.sku, price: v.price.toString() })),
    },
    ...meta,
  });
  return { id: product.id, variantIds };
}

async function updateProduct(
  tx: Tx,
  input: ProductInput & { id: string },
  actor: Actor,
  meta: Meta,
) {
  const before = await tx.product.findUnique({
    where: { id: input.id },
    include: { variants: { include: { barcodes: true } } },
  });
  if (!before) throw new ActionError("NOT_FOUND");
  const existing = new Map(before.variants.map((v) => [v.id, v]));
  for (const variant of input.variants) {
    if (variant.id && !existing.has(variant.id)) throw new ActionError("NOT_FOUND");
  }

  await tx.product.update({ where: { id: input.id }, data: productData(input) });
  await tx.productOption.deleteMany({ where: { productId: input.id } });
  if (input.options.length) {
    await tx.productOption.createMany({
      data: input.options.map((option, index) => ({
        productId: input.id,
        name: option.name,
        position: index + 1,
        values: option.values,
      })),
    });
  }

  // Free codes that are moving between this product's variants first, so the
  // unique indexes don't trip mid-update.
  const kept = new Set(input.variants.flatMap((v) => (v.id ? [v.id] : [])));
  await tx.productVariant.updateMany({
    where: { productId: input.id },
    data: { sku: null, pluCode: null },
  });
  await tx.barcode.deleteMany({ where: { variant: { productId: input.id } } });

  const variantIds: string[] = [];
  const priceChanges: { variantId: string; from: string; to: string }[] = [];
  for (const [position, variant] of input.variants.entries()) {
    const data = {
      ...variantData(variant, position),
      barcodes: { create: variant.barcodes.map((code) => ({ code })) },
    };
    if (variant.id) {
      const previous = existing.get(variant.id)!;
      await tx.productVariant.update({ where: { id: variant.id }, data });
      if (previous.price !== variant.price) {
        priceChanges.push({
          variantId: variant.id,
          from: previous.price.toString(),
          to: variant.price.toString(),
        });
      }
      variantIds.push(variant.id);
    } else {
      const created = await tx.productVariant.create({
        data: { ...data, productId: input.id, cost: variant.cost ?? 0n },
      });
      variantIds.push(created.id);
    }
  }

  // Variants left out of the form: delete if they have no history, else archive.
  const archived: string[] = [];
  for (const variant of before.variants) {
    if (kept.has(variant.id)) continue;
    const position = input.variants.length + archived.length;
    if (!(await deleteVariantIfUnused(tx, variant.id, position))) archived.push(variant.id);
  }

  await audit(tx, {
    actorId: actor.id,
    action: "product.update",
    entityType: "Product",
    entityId: input.id,
    before: { name: before.name, isActive: before.isActive },
    after: { name: input.name, isActive: input.isActive, archivedVariants: archived },
    ...meta,
  });
  for (const change of priceChanges) {
    await audit(tx, {
      actorId: actor.id,
      action: "product.price_change",
      entityType: "ProductVariant",
      entityId: change.variantId,
      before: { price: change.from },
      after: { price: change.to },
      ...meta,
    });
  }
  return { id: input.id, variantIds };
}

/**
 * Delete a variant that nothing references, else archive it. References are
 * counted first, so the transaction never hits a foreign-key error.
 * Returns true when deleted.
 */
async function deleteVariantIfUnused(tx: Tx, variantId: string, position: number) {
  const [movements, saleLines, poLines, receiptLines, countLines] = await Promise.all([
    tx.stockMovement.count({ where: { variantId } }),
    tx.saleLine.count({ where: { variantId } }),
    tx.purchaseOrderLine.count({ where: { variantId } }),
    tx.goodsReceiptLine.count({ where: { variantId } }),
    tx.stocktakeLine.count({ where: { variantId } }),
  ]);
  if (movements + saleLines + poLines + receiptLines + countLines === 0) {
    await tx.stockLevel.deleteMany({ where: { variantId } });
    await tx.productVariant.delete({ where: { id: variantId } });
    return true;
  }
  await tx.productVariant.update({ where: { id: variantId }, data: { isActive: false, position } });
  return false;
}

export async function setProductActive(
  tx: Tx,
  id: string,
  isActive: boolean,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const { count } = await tx.product.updateMany({ where: { id }, data: { isActive } });
  if (count === 0) throw new ActionError("NOT_FOUND");
  await audit(tx, {
    actorId: actor.id,
    action: isActive ? "product.restore" : "product.archive",
    entityType: "Product",
    entityId: id,
    ...meta,
  });
}

/** Delete a product only if none of its variants has any history; otherwise IN_USE. */
export async function deleteProduct(
  tx: Tx,
  id: string,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { id },
    include: { variants: { select: { id: true } } },
  });
  if (!product) throw new ActionError("NOT_FOUND");
  const variantIds = product.variants.map((v) => v.id);
  const references = await Promise.all([
    tx.stockMovement.count({ where: { variantId: { in: variantIds } } }),
    tx.saleLine.count({ where: { productId: id } }),
    tx.purchaseOrderLine.count({ where: { variantId: { in: variantIds } } }),
    tx.goodsReceiptLine.count({ where: { variantId: { in: variantIds } } }),
    tx.stocktakeLine.count({ where: { variantId: { in: variantIds } } }),
  ]);
  if (references.some((n) => n > 0)) throw new ActionError("IN_USE");
  await tx.stockLevel.deleteMany({ where: { variantId: { in: variantIds } } });
  await tx.product.delete({ where: { id } });
  await audit(tx, {
    actorId: actor.id,
    action: "product.delete",
    entityType: "Product",
    entityId: id,
    before: { name: product.name },
    ...meta,
  });
}
