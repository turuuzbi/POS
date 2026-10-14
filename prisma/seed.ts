/**
 * Development seed. Idempotent: creates what's missing and never overwrites
 * existing rows, so it's safe to re-run against a database you've been
 * using. Refuses to run in production unless SEED_ALLOW_PRODUCTION=1.
 *
 *   pnpm db:seed
 */
import { fromMajor } from "@/domain/money";
import { units } from "@/domain/qty";
import { ean13CheckDigit, normalizePlu } from "@/domain/scale-barcode";
import { hashPassword } from "@/server/auth/password";
import { pinLookup } from "@/server/auth/pin";
import { db } from "@/server/db";
import { postStockMovements } from "@/server/services/stock";
import { SEED_CATEGORIES, SEED_PRODUCTS } from "./seed-data";

const DEV_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "demo-password-2026";
/** Opening stock per variant: whole pieces, or kilograms for weighed goods. */
const OPENING_PIECES = 40;
const OPENING_KG = 25;

const STAFF = [
  { key: "owner", name: "Бат-Эрдэнэ", role: "OWNER", email: "owner@pos.local", pin: "905174" },
  { key: "manager", name: "Сарантуяа", role: "MANAGER", email: "manager@pos.local", pin: "583920" },
  { key: "cashier", name: "Болор", role: "CASHIER", email: null, pin: "482109" },
] as const;

/** Mongolia's GS1 prefix (865) + a demo company number + item number. */
function demoEan13(item: number): string {
  const first12 = `8650001${String(item).padStart(5, "0")}`;
  return first12 + String(ean13CheckDigit(first12));
}

async function seedSettingsAndTax() {
  const taxClasses = [
    { name: "НӨАТ 10%", treatment: "STANDARD", vatRateBps: 1000 },
    { name: "НӨАТ 0%", treatment: "ZERO_RATED", vatRateBps: 0 },
    { name: "НӨАТ-аас чөлөөлөгдсөн", treatment: "EXEMPT", vatRateBps: 0 },
  ] as const;
  for (const taxClass of taxClasses) {
    await db.taxClass.upsert({ where: { name: taxClass.name }, update: {}, create: taxClass });
  }
  const standard = await db.taxClass.findUniqueOrThrow({ where: { name: "НӨАТ 10%" } });
  await db.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      businessName: "Жишээ дэлгүүр",
      legalName: "Жишээ ХХК",
      phone: "7700-0000",
      address: "Улаанбаатар хот",
      defaultTaxClassId: standard.id,
      receiptFooter: "Худалдан авалт хийсэнд баярлалаа!",
    },
  });
  return standard;
}

async function seedLocation() {
  const location = await db.location.upsert({
    where: { code: "UB1" },
    update: {},
    create: { code: "UB1", name: "Төв салбар", address: "Улаанбаатар, Сүхбаатар дүүрэг" },
  });
  const registers = [];
  for (const [code, name] of [
    ["R1", "Касс 1"],
    ["R2", "Касс 2"],
  ] as const) {
    registers.push(
      await db.register.upsert({
        where: { locationId_code: { locationId: location.id, code } },
        update: {},
        create: { locationId: location.id, code, name },
      }),
    );
  }
  return { location, registers };
}

async function seedStaff(locationId: string) {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  for (const member of STAFF) {
    const lookup = pinLookup(member.pin);
    // Email for staff who have one; PIN-only staff match by name+role (stable
    // across PIN_PEPPER changes) or by PIN (stable across renames).
    const existing = await db.user.findFirst({
      where: member.email
        ? { email: member.email }
        : {
            OR: [{ name: member.name, role: member.role, email: null }, { pinLookup: lookup }],
          },
    });
    if (existing) continue;
    await db.user.create({
      data: {
        name: member.name,
        role: member.role,
        email: member.email,
        passwordHash: member.email ? passwordHash : null,
        pinLookup: lookup,
        locations: { create: { locationId } },
      },
    });
  }
}

async function seedCatalog(taxClassId: string) {
  const categoryIds = new Map<string, string>();
  for (const [index, category] of SEED_CATEGORIES.entries()) {
    const existing = await db.category.findFirst({
      where: { name: category.name, parentId: null },
    });
    const row =
      existing ??
      (await db.category.create({
        data: { name: category.name, color: category.color, sortOrder: index },
      }));
    categoryIds.set(category.name, row.id);
  }

  let created = 0;
  for (const product of SEED_PRODUCTS) {
    const firstSku = product.variants[0]?.sku;
    if (!firstSku || (await db.productVariant.findUnique({ where: { sku: firstSku } }))) continue;
    const hasOptions = product.variants.length > 1;
    await db.product.create({
      data: {
        name: product.name,
        type: product.type ?? "STANDARD",
        unit: product.unit,
        categoryId: categoryIds.get(product.category) ?? null,
        taxClassId,
        pricesIncludeTax: true,
        trackStock: product.type !== "SERVICE",
        options:
          hasOptions && product.optionName
            ? {
                create: {
                  name: product.optionName,
                  position: 1,
                  values: product.variants.map((v) => v.name ?? ""),
                },
              }
            : undefined,
        variants: {
          create: product.variants.map((variant, position) => ({
            sku: variant.sku,
            name: hasOptions ? (variant.name ?? null) : null,
            option1: hasOptions ? (variant.name ?? null) : null,
            price: fromMajor(variant.priceMnt),
            cost: fromMajor(variant.costMnt),
            pluCode: variant.plu ? normalizePlu(variant.plu) : null,
            position,
            barcodes: variant.ean ? { create: { code: demoEan13(variant.ean) } } : undefined,
          })),
        },
      },
    });
    created++;
  }
  return created;
}

/**
 * Opening stock through the stock service: one OPENING movement per stocked
 * variant that has no movement at the location yet (idempotent), plus
 * reorder points for the low-stock list.
 */
async function seedOpeningStock(locationId: string, createdById: string) {
  const variants = await db.productVariant.findMany({
    where: {
      product: { trackStock: true, type: "STANDARD" },
      stockMovements: { none: { locationId } },
    },
    include: { product: { select: { unit: true } } },
    orderBy: { id: "asc" },
  });
  if (variants.length === 0) return 0;
  const qtyFor = (unit: string) => units(unit === "PIECE" ? OPENING_PIECES : OPENING_KG);
  await db.$transaction(
    async (tx) => {
      await postStockMovements(tx, {
        locationId,
        type: "OPENING",
        createdById,
        note: "Seed opening stock",
        lines: variants.map((v) => ({ variantId: v.id, qtyDeltaMilli: qtyFor(v.product.unit) })),
      });
      for (const variant of variants) {
        const qty = qtyFor(variant.product.unit);
        await tx.stockLevel.update({
          where: { variantId_locationId: { variantId: variant.id, locationId } },
          data: { reorderPointMilli: Math.round(qty / 4), reorderQtyMilli: qty },
        });
      }
    },
    { timeout: 120_000 },
  );
  return variants.length;
}

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") {
    throw new Error(
      "Refusing to seed a production database (set SEED_ALLOW_PRODUCTION=1 to override).",
    );
  }
  console.warn("Seeding settings and tax classes…");
  const standard = await seedSettingsAndTax();
  const { location } = await seedLocation();
  console.warn("Seeding staff…");
  await seedStaff(location.id);
  console.warn("Seeding catalog…");
  const created = await seedCatalog(standard.id);
  const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@pos.local" } });
  console.warn("Seeding opening stock…");
  const stocked = await seedOpeningStock(location.id, owner.id);

  console.warn(
    `Seed complete: ${created} new products (${SEED_PRODUCTS.length} in catalog), ` +
      `opening stock for ${stocked} variants.`,
  );
  console.warn("Development sign-in (change these before any real use):");
  for (const member of STAFF) {
    const login = member.email ? `${member.email} / ${DEV_PASSWORD}` : "PIN only";
    console.warn(
      `  ${member.role.padEnd(8)} ${member.name.padEnd(12)} ${login}  PIN ${member.pin}`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
