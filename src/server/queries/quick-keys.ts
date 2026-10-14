import "server-only";
import { db } from "../db";

export interface QuickKeyTile {
  id: string;
  position: number;
  color: string | null;
  productId: string;
  name: string;
  /** Lowest active variant price (möngö); the register may ask which variant. */
  price: bigint | null;
  variantCount: number;
  isActive: boolean;
}

/** A grid's keys in cashier order. */
export async function listQuickKeys(
  locationId: string,
  categoryId: string | null,
): Promise<QuickKeyTile[]> {
  const keys = await db.quickKey.findMany({
    where: { locationId, categoryId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: {
      product: {
        select: {
          name: true,
          isActive: true,
          variants: { where: { isActive: true }, select: { price: true } },
        },
      },
    },
  });
  return keys.map((key) => {
    const prices = key.product.variants.map((v) => v.price);
    return {
      id: key.id,
      position: key.position,
      color: key.color,
      productId: key.productId,
      name: key.product.name,
      price: prices.length ? prices.reduce((min, p) => (p < min ? p : min)) : null,
      variantCount: prices.length,
      isActive: key.product.isActive,
    };
  });
}

export interface QuickKeyTabSummary {
  /** null = the favourites tab. */
  categoryId: string | null;
  name: string | null;
  keyCount: number;
}

/** Favourites plus every active category, with how many keys each holds here. */
export async function listQuickKeyTabs(locationId: string): Promise<QuickKeyTabSummary[]> {
  const [categories, counts] = await Promise.all([
    db.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    db.quickKey.groupBy({ by: ["categoryId"], where: { locationId }, _count: { _all: true } }),
  ]);
  const count = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  return [
    { categoryId: null, name: null, keyCount: count.get(null) ?? 0 },
    ...categories.map((c) => ({
      categoryId: c.id,
      name: c.name,
      keyCount: count.get(c.id) ?? 0,
    })),
  ];
}
