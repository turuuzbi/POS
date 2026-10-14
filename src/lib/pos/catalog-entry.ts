/**
 * What the register knows about a sellable variant. Plain data (bigint money,
 * milli quantities) so it crosses the server-action boundary and fits the
 * pure cart domain's `CatalogVariant`.
 */
import { z } from "zod";
import type { CatalogSnapshot, CatalogVariant } from "@/domain/cart";
import { UNITS, type Unit } from "@/domain/qty";
import type { TaxTreatment } from "@/domain/tax";

export interface CatalogEntry {
  variantId: string;
  productId: string;
  /** Product name plus variant options, ready to show. */
  label: string;
  sku: string | null;
  barcode: string | null;
  unit: Unit;
  /** Listed unit price in möngö (per whole unit). */
  price: bigint;
  pricesIncludeTax: boolean;
  taxTreatment: TaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  pluCode: string | null;
  categoryId: string | null;
  productType: string;
  /** On hand at the register's location, when tracked (display only). */
  onHandMilli: number | null;
}

export function toCatalogVariant(entry: CatalogEntry): CatalogVariant {
  return {
    variantId: entry.variantId,
    productId: entry.productId,
    name: entry.label,
    ...(entry.sku ? { sku: entry.sku } : {}),
    categoryId: entry.categoryId,
    productType: entry.productType,
    unit: entry.unit,
    price: entry.price,
    pricesIncludeTax: entry.pricesIncludeTax,
    taxTreatment: entry.taxTreatment,
    vatRateBps: entry.vatRateBps,
    cityTaxRateBps: entry.cityTaxRateBps,
    pluCode: entry.pluCode,
  };
}

export function snapshotOf(entries: Readonly<Record<string, CatalogEntry>>): CatalogSnapshot {
  const variants: Record<string, CatalogVariant> = {};
  for (const [id, entry] of Object.entries(entries)) variants[id] = toCatalogVariant(entry);
  return { variants };
}

// --- Storage form (bigint -> decimal string) --------------------------------

const bigintString = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((v) => BigInt(v));

export const catalogEntryJsonSchema = z.object({
  variantId: z.string().min(1),
  productId: z.string().min(1),
  label: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  unit: z.enum(UNITS),
  price: bigintString,
  pricesIncludeTax: z.boolean(),
  taxTreatment: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT"]),
  vatRateBps: z.number().int(),
  cityTaxRateBps: z.number().int(),
  pluCode: z.string().nullable(),
  categoryId: z.string().nullable(),
  productType: z.string(),
  onHandMilli: z.number().int().nullable(),
});

export type CatalogEntryJson = Omit<CatalogEntry, "price"> & { price: string };

export function entryToJson(entry: CatalogEntry): CatalogEntryJson {
  return { ...entry, price: entry.price.toString() };
}

export function entryFromJson(json: unknown): CatalogEntry | null {
  const parsed = catalogEntryJsonSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Entries by variant id, newest wins. */
export function indexEntries(entries: readonly CatalogEntry[]): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const entry of entries) out[entry.variantId] = entry;
  return out;
}
