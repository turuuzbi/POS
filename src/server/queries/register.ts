import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { variantLabel } from "@/domain/catalog";
import {
  DEFAULT_SCALE_RULES,
  normalizePlu,
  parseScaleBarcode,
  scaleBarcodeRulesSchema,
  type ScaleBarcodeRule,
} from "@/domain/scale-barcode";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { searchVariants } from "./catalog";
import { getOpenShift, type OpenShift } from "./shifts";

// ---------------------------------------------------------------------------
// Catalog entries (what the register needs to price a variant locally)
// ---------------------------------------------------------------------------

function entrySelect(locationId: string | null) {
  return {
    id: true,
    productId: true,
    name: true,
    option1: true,
    option2: true,
    option3: true,
    sku: true,
    pluCode: true,
    price: true,
    product: {
      select: {
        name: true,
        unit: true,
        type: true,
        categoryId: true,
        pricesIncludeTax: true,
        taxClass: { select: { treatment: true, vatRateBps: true, cityTaxRateBps: true } },
      },
    },
    barcodes: { select: { code: true }, take: 1, orderBy: { id: "asc" as const } },
    stockLevels: locationId ? { where: { locationId }, select: { onHandMilli: true } } : false,
  } satisfies Prisma.ProductVariantSelect;
}

type EntryRow = Prisma.ProductVariantGetPayload<{ select: ReturnType<typeof entrySelect> }>;

function toEntry(row: EntryRow): CatalogEntry {
  return {
    variantId: row.id,
    productId: row.productId,
    label: variantLabel(row.product.name, row),
    sku: row.sku,
    barcode: row.barcodes[0]?.code ?? null,
    unit: row.product.unit,
    price: row.price,
    pricesIncludeTax: row.product.pricesIncludeTax,
    taxTreatment: row.product.taxClass.treatment,
    vatRateBps: row.product.taxClass.vatRateBps,
    cityTaxRateBps: row.product.taxClass.cityTaxRateBps,
    pluCode: row.pluCode,
    categoryId: row.product.categoryId,
    productType: row.product.type,
    onHandMilli: row.stockLevels ? (row.stockLevels[0]?.onHandMilli ?? 0) : null,
  };
}

const SELLABLE: Prisma.ProductVariantWhereInput = {
  isActive: true,
  product: { isActive: true, type: { not: "GIFT_CARD" } },
};

/** Entries for the given variants (inactive ones are left out), in the given order. */
export async function loadEntries(
  variantIds: readonly string[],
  locationId: string | null,
): Promise<CatalogEntry[]> {
  if (variantIds.length === 0) return [];
  const rows = await db.productVariant.findMany({
    where: { AND: [{ id: { in: [...variantIds] } }, SELLABLE] },
    select: entrySelect(locationId),
  });
  const byId = new Map(rows.map((row) => [row.id, toEntry(row)]));
  return variantIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export async function searchEntries(
  query: string,
  locationId: string | null,
): Promise<CatalogEntry[]> {
  const hits = await searchVariants(query, { locationId, limit: 20 });
  return loadEntries(
    hits.map((hit) => hit.variantId),
    locationId,
  );
}

export interface CodeLookup {
  entry: CatalogEntry | null;
  /** Set when the code was a scale label (weight / price embedded). */
  scaleBarcode: string | null;
}

export async function loadScaleRules(): Promise<readonly ScaleBarcodeRule[]> {
  const settings = await db.businessSettings.findUnique({
    where: { id: 1 },
    select: { scaleBarcodeRules: true },
  });
  const parsed = scaleBarcodeRulesSchema.safeParse(settings?.scaleBarcodeRules);
  return parsed.success && parsed.data.length > 0 ? parsed.data : DEFAULT_SCALE_RULES;
}

/**
 * Resolve a scanned/typed code to one variant: barcode, SKU, PLU (exact),
 * then scale labels. A single indexed lookup for the common case.
 */
export async function lookupCode(code: string, locationId: string | null): Promise<CodeLookup> {
  const q = code.trim().slice(0, 100);
  if (!q) return { entry: null, scaleBarcode: null };
  const select = entrySelect(locationId);

  const byCode = await db.productVariant.findFirst({
    where: {
      AND: [
        SELLABLE,
        {
          OR: [
            { barcodes: { some: { code: q } } },
            { sku: { equals: q, mode: "insensitive" } },
            ...(/^\d{1,7}$/.test(q) ? [{ pluCode: normalizePlu(q) }] : []),
          ],
        },
      ],
    },
    select,
  });
  if (byCode) return { entry: toEntry(byCode), scaleBarcode: null };

  if (/^\d{13}$/.test(q)) {
    const match = parseScaleBarcode(q, await loadScaleRules());
    if (match) {
      const row = await db.productVariant.findFirst({
        where: { AND: [SELLABLE, { pluCode: match.pluCode }] },
        select,
      });
      if (row) return { entry: toEntry(row), scaleBarcode: q };
    }
  }
  return { entry: null, scaleBarcode: null };
}

/** Descendant category ids (inclusive), so a parent tab shows its children's products. */
async function categoryAndDescendants(categoryId: string): Promise<string[]> {
  const rows = await db.category.findMany({
    where: { isActive: true },
    select: { id: true, parentId: true },
  });
  const out = new Set<string>([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentId && out.has(row.parentId) && !out.has(row.id)) {
        out.add(row.id);
        grew = true;
      }
    }
  }
  return [...out];
}

export const BROWSE_LIMIT = 80;

/** Sellable variants for the browse grid: one category (with children) or everything. */
export async function browseEntries(
  categoryId: string | null,
  locationId: string | null,
): Promise<CatalogEntry[]> {
  const categoryIds = categoryId ? await categoryAndDescendants(categoryId) : null;
  const rows = await db.productVariant.findMany({
    where: {
      AND: [SELLABLE, categoryIds ? { product: { categoryId: { in: categoryIds } } } : {}],
    },
    select: entrySelect(locationId),
    orderBy: [{ product: { name: "asc" } }, { position: "asc" }],
    take: BROWSE_LIMIT,
  });
  return rows.map(toEntry);
}

// ---------------------------------------------------------------------------
// Register context (page data)
// ---------------------------------------------------------------------------

export interface QuickKeyTile {
  id: string;
  /** Tab: a category id, or null for the favourites tab. */
  categoryId: string | null;
  productId: string;
  color: string | null;
  position: number;
  /** The product's sellable variants (a tile with several opens a chooser). */
  variantIds: string[];
  name: string;
}

export interface RegisterCategory {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
}

export interface RegisterContext {
  device: {
    id: string;
    name: string;
    locationId: string;
    locationName: string;
    registerId: string | null;
    registerName: string | null;
  } | null;
  shift: OpenShift | null;
  settings: { totalRoundingUnit: bigint; scaleRules: readonly ScaleBarcodeRule[] };
  categories: RegisterCategory[];
  quickKeys: QuickKeyTile[];
  /** Entries behind the quick keys, so a tap prices locally. */
  entries: CatalogEntry[];
}

/**
 * The open shift of the device's register. `getOpenShift` belongs to the
 * shifts service. POS_E2E_SHIFT_FALLBACK=1 (never set in production) lets the
 * browser tests run before that service is merged by reading a real OPEN
 * Shift row they inserted.
 */
async function openShiftFor(registerId: string | null): Promise<OpenShift | null> {
  const shift = await getOpenShift();
  if (shift || !registerId || process.env.POS_E2E_SHIFT_FALLBACK !== "1") return shift;
  const row = await db.shift.findFirst({
    where: { registerId, status: "OPEN" },
    select: { id: true, registerId: true, locationId: true, openedAt: true, openingFloat: true },
  });
  return row;
}

export async function getRegisterContext(_user: CurrentUser): Promise<RegisterContext> {
  const row = await findActiveDevice(db, await readDeviceToken());
  const device = row
    ? {
        id: row.id,
        name: row.name,
        locationId: row.locationId,
        locationName: row.location.name,
        registerId: row.registerId,
        registerName: row.register?.name ?? null,
      }
    : null;
  const locationId = device?.locationId ?? null;

  const [settings, shift, categories, keys] = await Promise.all([
    db.businessSettings.findUnique({
      where: { id: 1 },
      select: { totalRoundingUnit: true, scaleBarcodeRules: true },
    }),
    device ? openShiftFor(device.registerId) : Promise.resolve(null),
    db.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, color: true, parentId: true },
    }),
    db.quickKey.findMany({
      where: {
        OR: locationId ? [{ locationId }, { locationId: null }] : [{ locationId: null }],
        product: { isActive: true },
      },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 300,
      select: {
        id: true,
        categoryId: true,
        productId: true,
        color: true,
        position: true,
        product: {
          select: {
            name: true,
            variants: {
              where: { isActive: true },
              orderBy: { position: "asc" },
              select: { id: true },
            },
          },
        },
      },
    }),
  ]);

  const tiles: QuickKeyTile[] = keys
    .filter((key) => key.product.variants.length > 0)
    .map((key) => ({
      id: key.id,
      categoryId: key.categoryId,
      productId: key.productId,
      color: key.color,
      position: key.position,
      variantIds: key.product.variants.map((v) => v.id),
      name: key.product.name,
    }));
  const entries = await loadEntries(
    [...new Set(tiles.flatMap((tile) => tile.variantIds))],
    locationId,
  );
  const sellable = new Set(entries.map((e) => e.variantId));
  const parsedRules = scaleBarcodeRulesSchema.safeParse(settings?.scaleBarcodeRules);

  return {
    device,
    shift,
    settings: {
      totalRoundingUnit: settings?.totalRoundingUnit ?? 100n,
      scaleRules:
        parsedRules.success && parsedRules.data.length > 0 ? parsedRules.data : DEFAULT_SCALE_RULES,
    },
    categories,
    quickKeys: tiles
      .map((tile) => ({ ...tile, variantIds: tile.variantIds.filter((id) => sellable.has(id)) }))
      .filter((tile) => tile.variantIds.length > 0),
    entries,
  };
}
