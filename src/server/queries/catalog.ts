import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { variantLabel } from "@/domain/catalog";
import { db } from "../db";

export interface VariantHit {
  variantId: string;
  productId: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  unit: "PIECE" | "KG" | "LITER" | "METER";
  price: bigint;
  cost: bigint;
  trackStock: boolean;
  /** On hand at the requested location (null when no location was given). */
  onHandMilli: number | null;
  /** True when the query was an exact barcode, SKU or PLU match. */
  exact: boolean;
}

/**
 * Find sellable/stockable variants by barcode, SKU, PLU (exact) or product
 * name (substring, trigram-indexed). Exact code matches come first, so a
 * scanner's "type the code + Enter" lands on the right item.
 */
export async function searchVariants(
  query: string,
  options: {
    locationId?: string | null;
    limit?: number;
    includeInactive?: boolean;
    /** Only stock-tracked, standard products (inventory screens). */
    stockOnly?: boolean;
  } = {},
): Promise<VariantHit[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const limit = Math.min(options.limit ?? 20, 50);
  const active = options.includeInactive ? {} : { isActive: true, product: { isActive: true } };
  const stock = options.stockOnly
    ? { product: { trackStock: true, type: "STANDARD" as const } }
    : {};
  const where = (match: Prisma.ProductVariantWhereInput): Prisma.ProductVariantWhereInput => ({
    AND: [match, active, stock],
  });
  const select = {
    id: true,
    name: true,
    option1: true,
    option2: true,
    option3: true,
    sku: true,
    price: true,
    cost: true,
    productId: true,
    product: { select: { name: true, unit: true, trackStock: true } },
    barcodes: { select: { code: true }, take: 1 },
    stockLevels: options.locationId
      ? { where: { locationId: options.locationId }, select: { onHandMilli: true } }
      : false,
  } satisfies Prisma.ProductVariantSelect;

  const exact = await db.productVariant.findMany({
    where: where({
      OR: [
        { barcodes: { some: { code: q } } },
        { sku: { equals: q, mode: "insensitive" } },
        ...(/^\d{1,7}$/.test(q) ? [{ pluCode: q.replace(/^0+(?=\d)/, "") }] : []),
      ],
    }),
    select,
    take: limit,
  });
  const exactIds = new Set(exact.map((v) => v.id));
  const fuzzy =
    exact.length >= limit
      ? []
      : await db.productVariant.findMany({
          where: where({
            id: { notIn: [...exactIds] },
            OR: [
              { product: { name: { contains: q, mode: "insensitive" } } },
              { name: { contains: q, mode: "insensitive" } },
              { sku: { startsWith: q, mode: "insensitive" } },
            ],
          }),
          select,
          orderBy: [{ product: { name: "asc" } }, { position: "asc" }],
          take: limit - exact.length,
        });

  return [...exact, ...fuzzy].map((v) => ({
    variantId: v.id,
    productId: v.productId,
    label: variantLabel(v.product.name, v),
    sku: v.sku,
    barcode: v.barcodes[0]?.code ?? null,
    unit: v.product.unit,
    price: v.price,
    cost: v.cost,
    trackStock: v.product.trackStock,
    onHandMilli: options.locationId ? (v.stockLevels?.[0]?.onHandMilli ?? 0) : null,
    exact: exactIds.has(v.id),
  }));
}

/** Categories as a flat list in tree order, each with its depth (for pickers). */
export async function listCategoryTree(options: { includeInactive?: boolean } = {}) {
  const rows = await db.category.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      parentId: true,
      color: true,
      sortOrder: true,
      isActive: true,
      _count: { select: { products: true } },
    },
  });
  const children = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const parent = rows.some((r) => r.id === row.parentId) ? row.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const out: ((typeof rows)[number] & { depth: number; path: string })[] = [];
  const walk = (parentId: string | null, depth: number, path: string) => {
    for (const row of children.get(parentId) ?? []) {
      const rowPath = path ? `${path} › ${row.name}` : row.name;
      out.push({ ...row, depth, path: rowPath });
      if (depth < 20) walk(row.id, depth + 1, rowPath);
    }
  };
  walk(null, 0, "");
  return out;
}

export type CategoryTreeRow = Awaited<ReturnType<typeof listCategoryTree>>[number];

export function listTaxClasses(options: { includeInactive?: boolean } = {}) {
  return db.taxClass.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
}
