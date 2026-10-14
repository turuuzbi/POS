import "server-only";
import { CSV_BOM, csvHeader, productToCsv, type ExportProduct } from "@/domain/csv-catalog";
import { db } from "../db";

const BATCH = 200;

/**
 * The whole catalog as CSV text chunks (BOM + header first, then one chunk
 * per batch of products), read with keyset pagination so memory stays flat.
 */
export async function* catalogCsvChunks(withCosts: boolean): AsyncGenerator<string> {
  yield CSV_BOM + csvHeader(withCosts);
  const categories = await db.category.findMany({
    select: { id: true, name: true, parentId: true },
  });
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string | null): string | null => {
    const parts: string[] = [];
    for (let c = id ? byId.get(id) : undefined, depth = 0; c && depth < 20; depth++) {
      parts.unshift(c.name);
      c = c.parentId ? byId.get(c.parentId) : undefined;
    }
    return parts.length ? parts.join(" > ") : null;
  };

  let after: string | undefined;
  for (;;) {
    const products = await db.product.findMany({
      take: BATCH,
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: "asc" },
      include: {
        taxClass: { select: { name: true } },
        options: { orderBy: { position: "asc" }, select: { name: true } },
        variants: {
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          include: { barcodes: { orderBy: { code: "asc" }, select: { code: true } } },
        },
      },
    });
    if (products.length === 0) return;
    after = products.at(-1)!.id;
    const rows: ExportProduct[] = products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: p.type,
      unit: p.unit,
      categoryPath: pathOf(p.categoryId),
      taxClassName: p.taxClass.name,
      pricesIncludeTax: p.pricesIncludeTax,
      trackStock: p.trackStock,
      taxClassificationCode: p.taxClassificationCode,
      isActive: p.isActive,
      optionNames: p.options.map((o) => o.name),
      variants: p.variants.map((v) => ({
        name: v.name,
        sku: v.sku,
        pluCode: v.pluCode,
        barcodes: v.barcodes.map((b) => b.code),
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        price: v.price,
        cost: v.cost,
        isActive: v.isActive,
      })),
    }));
    yield rows.map((p) => productToCsv(p, withCosts)).join("");
    if (products.length < BATCH) return;
  }
}
