import "server-only";
import { db } from "../db";

/** Every tax class (archived too) with its product count and whether it is the business default. */
export async function listTaxClassesWithUsage() {
  const [classes, settings] = await Promise.all([
    db.taxClass.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    }),
    db.businessSettings.findUnique({ where: { id: 1 }, select: { defaultTaxClassId: true } }),
  ]);
  return classes.map((c) => ({ ...c, isDefault: c.id === settings?.defaultTaxClassId }));
}
