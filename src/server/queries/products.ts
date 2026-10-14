import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { listCategoryTree } from "./catalog";
import { userLocationFilter } from "./locations";

export const PRODUCT_PAGE_SIZE = 25;

export const PRODUCT_STATUSES = ["active", "archived", "all"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface ProductListFilters {
  q?: string;
  categoryId?: string;
  status?: ProductStatus;
  page?: number;
}

type Scope = Pick<CurrentUser, "locationIds">;

/** Sum of on-hand milli-units per (variant → location), limited to the user's locations. */
async function stockByVariant(variantIds: string[], user: Scope) {
  const out = new Map<string, Map<string, number>>();
  if (variantIds.length === 0) return out;
  const rows = await db.stockLevel.findMany({
    where: {
      variantId: { in: variantIds },
      location: { isActive: true, ...userLocationFilter(user) },
    },
    select: { variantId: true, locationId: true, onHandMilli: true },
  });
  for (const row of rows) {
    const byLocation = out.get(row.variantId) ?? new Map<string, number>();
    byLocation.set(row.locationId, row.onHandMilli);
    out.set(row.variantId, byLocation);
  }
  return out;
}

/** The category and every category below it. */
async function categorySubtree(categoryId: string): Promise<string[]> {
  const rows = await db.category.findMany({ select: { id: true, parentId: true } });
  const ids = new Set([categoryId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

export async function listProducts(filters: ProductListFilters, user: Scope) {
  const status = filters.status ?? "active";
  const q = filters.q?.trim().slice(0, 100);
  const page = Math.max(1, Math.floor(filters.page ?? 1));

  const and: Prisma.ProductWhereInput[] = [];
  if (status !== "all") and.push({ isActive: status === "active" });
  if (filters.categoryId)
    and.push({ categoryId: { in: await categorySubtree(filters.categoryId) } });
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
        { variants: { some: { barcodes: { some: { code: q } } } } },
        ...(/^\d{1,7}$/.test(q)
          ? [{ variants: { some: { pluCode: q.replace(/^0+(?=\d)/, "") } } }]
          : []),
      ],
    });
  }
  const where: Prisma.ProductWhereInput = { AND: and };

  const [total, products, locations] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        imageUrl: true,
        type: true,
        unit: true,
        trackStock: true,
        isActive: true,
        category: { select: { name: true } },
        variants: {
          orderBy: { position: "asc" },
          select: { id: true, sku: true, price: true, isActive: true },
        },
      },
    }),
    db.location.findMany({
      where: { isActive: true, ...userLocationFilter(user) },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const stock = await stockByVariant(
    products.flatMap((p) => (p.trackStock ? p.variants.map((v) => v.id) : [])),
    user,
  );

  const rows = products.map((product) => {
    const live = product.variants.filter((v) => v.isActive);
    const prices = (live.length ? live : product.variants).map((v) => v.price);
    const onHand: Record<string, number> = {};
    if (product.trackStock) {
      for (const location of locations) {
        onHand[location.id] = product.variants.reduce(
          (sum, v) => sum + (stock.get(v.id)?.get(location.id) ?? 0),
          0,
        );
      }
    }
    return {
      id: product.id,
      name: product.name,
      imageUrl: product.imageUrl,
      type: product.type,
      unit: product.unit,
      trackStock: product.trackStock,
      isActive: product.isActive,
      category: product.category?.name ?? null,
      variantCount: product.variants.length,
      firstSku: product.variants.find((v) => v.sku)?.sku ?? null,
      minPrice: prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : 0n,
      maxPrice: prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : 0n,
      onHand,
    };
  });

  return {
    rows,
    locations,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE)),
  };
}

/** A product with everything the form needs, plus on-hand per variant at the user's locations. */
export async function getProductForEdit(id: string, user: Scope) {
  const product = await db.product.findUnique({
    where: { id },
    include: {
      options: { orderBy: { position: "asc" } },
      variants: {
        orderBy: { position: "asc" },
        include: { barcodes: { orderBy: { code: "asc" } } },
      },
    },
  });
  if (!product) return null;
  const stock = await stockByVariant(
    product.variants.map((v) => v.id),
    user,
  );
  const onHand = Object.fromEntries(
    product.variants.map((v) => [
      v.id,
      [...(stock.get(v.id)?.values() ?? [])].reduce((a, b) => a + b, 0),
    ]),
  );
  return { product, onHand };
}

/**
 * Pickers for the form: active categories and tax classes, plus the ones the
 * product already uses even if archived (so editing never silently swaps them).
 */
export async function productFormOptions(
  current: { categoryId?: string | null; taxClassId?: string } = {},
) {
  const [categories, taxClasses, defaults] = await Promise.all([
    listCategoryTree({ includeInactive: true }),
    db.taxClass.findMany({ orderBy: { name: "asc" } }),
    db.businessSettings.findUnique({ where: { id: 1 }, select: { defaultTaxClassId: true } }),
  ]);
  return {
    categories: categories
      .filter((c) => c.isActive || c.id === current.categoryId)
      .map((c) => ({ id: c.id, path: c.path })),
    taxClasses: taxClasses
      .filter((t) => t.isActive || t.id === current.taxClassId)
      .map((t) => ({ id: t.id, name: t.name })),
    defaultTaxClassId: defaults?.defaultTaxClassId ?? null,
  };
}
