/**
 * Catalog input validation (pure; shared by client forms and server actions).
 *
 * Validation messages are stable codes, not prose: the UI translates them
 * from the `validation` message namespace (see <FieldError>).
 */
import { z } from "zod";
import { parseMoney, type Money } from "./money";
import { UNITS } from "./qty";
import { ean13CheckDigit, normalizePlu } from "./scale-barcode";

export const VALIDATION_CODES = [
  "required",
  "tooLong",
  "invalid",
  "invalidMoney",
  "invalidQty",
  "invalidBarcode",
  "invalidPlu",
  "duplicate",
  "cycle",
  "inactive",
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

/** Largest price/cost accepted: 1 billion ₮. */
export const MAX_MONEY: Money = 100_000_000_000n;

export const PRODUCT_TYPES = ["STANDARD", "SERVICE", "GIFT_CARD"] as const;
export const TAX_TREATMENTS = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;
export const MAX_VARIANTS = 100;
export const MAX_OPTIONS = 3;
export const MAX_BARCODES_PER_VARIANT = 20;

export const requiredText = (max: number) =>
  z.string().trim().min(1, "required").max(max, "tooLong");

/** Optional free text: blank becomes null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .nullish()
    .transform((value) => (value ? value : null));

/** Tögrög typed by a person ("12,500", "1250.50") → möngö. */
export const moneyField = z.string().transform((value, ctx): Money => {
  const parsed = parseMoney(value);
  if (parsed === null || parsed < 0n || parsed > MAX_MONEY) {
    ctx.addIssue({ code: "custom", message: "invalidMoney" });
    return z.NEVER;
  }
  return parsed;
});

/** A rate typed as a percentage ("10", "2.5") → basis points. */
export const percentField = z.string().transform((value, ctx): number => {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
  if (!Number.isInteger(bps) || bps > 10_000) {
    ctx.addIssue({ code: "custom", message: "invalid" });
    return z.NEVER;
  }
  return bps;
});

/** True when a numeric code of a GS1 length carries a valid check digit. */
export function hasValidCheckDigit(code: string): boolean {
  if (!/^\d+$/.test(code)) return true; // alphanumeric (Code 128 etc.): no check digit
  if (code.length === 13) return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
  if (code.length === 12 || code.length === 8) {
    // UPC-A and EAN-8 use the same mod-10 weights, right-aligned.
    return ean13CheckDigit(code.slice(0, -1).padStart(12, "0")) === Number(code.at(-1));
  }
  return true;
}

export const barcodeField = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z.\-]{4,32}$/, "invalidBarcode")
  .refine(hasValidCheckDigit, "invalidBarcode");

export const skuField = z
  .string()
  .trim()
  .max(64, "tooLong")
  .regex(/^[^\s]*$/, "invalid")
  .nullish()
  .transform((value) => (value ? value : null));

/** Scale item code: up to 7 digits, stored without leading zeros. */
export const pluField = z
  .string()
  .trim()
  .regex(/^\d{0,7}$/, "invalidPlu")
  .nullish()
  .transform((value) => (value ? normalizePlu(value) : null));

export const categoryInputSchema = z.object({
  name: requiredText(80),
  parentId: z.uuid().nullable(),
  color: z
    .string()
    .regex(/^[a-z]+$/, "invalid")
    .max(20, "tooLong")
    .nullish()
    .transform((value) => value ?? null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type CategoryInput = z.output<typeof categoryInputSchema>;

export const taxClassInputSchema = z.object({
  name: requiredText(60),
  treatment: z.enum(TAX_TREATMENTS),
  vatRate: percentField,
  cityTaxRate: percentField,
});
export type TaxClassInput = z.output<typeof taxClassInputSchema>;

const optionValue = requiredText(40);

export const variantInputSchema = z.object({
  /** Existing variant being edited; omitted for a new one. */
  id: z.uuid().optional(),
  name: optionalText(80),
  sku: skuField,
  pluCode: pluField,
  option1: optionalText(40),
  option2: optionalText(40),
  option3: optionalText(40),
  price: moneyField,
  /** Initial unit cost (new variants only; receiving maintains it afterwards). */
  cost: moneyField.optional(),
  barcodes: z.array(barcodeField).max(MAX_BARCODES_PER_VARIANT, "tooLong").default([]),
  isActive: z.boolean().default(true),
});
export type VariantInput = z.output<typeof variantInputSchema>;

export const productInputSchema = z
  .object({
    name: requiredText(160),
    description: optionalText(2000),
    type: z.enum(PRODUCT_TYPES),
    unit: z.enum(UNITS),
    categoryId: z.uuid().nullable(),
    taxClassId: z.uuid(),
    pricesIncludeTax: z.boolean(),
    trackStock: z.boolean(),
    taxClassificationCode: optionalText(32),
    isActive: z.boolean().default(true),
    options: z
      .array(
        z.object({
          name: requiredText(40),
          values: z.array(optionValue).min(1, "required").max(50, "tooLong"),
        }),
      )
      .max(MAX_OPTIONS, "tooLong")
      .default([]),
    variants: z.array(variantInputSchema).min(1, "required").max(MAX_VARIANTS, "tooLong"),
  })
  .superRefine((product, ctx) => {
    if (product.type !== "STANDARD" && product.trackStock) {
      ctx.addIssue({ code: "custom", path: ["trackStock"], message: "invalid" });
    }
    if (product.type === "GIFT_CARD" && product.unit !== "PIECE") {
      ctx.addIssue({ code: "custom", path: ["unit"], message: "invalid" });
    }
    const optionNames = new Set<string>();
    product.options.forEach((option, index) => {
      const key = option.name.toLowerCase();
      if (optionNames.has(key)) {
        ctx.addIssue({ code: "custom", path: ["options", index, "name"], message: "duplicate" });
      }
      optionNames.add(key);
    });

    const seen = { sku: new Map<string, number>(), plu: new Map<string, number>() };
    const barcodes = new Map<string, number>();
    const combos = new Set<string>();
    product.variants.forEach((variant, index) => {
      const flag = (field: string, message: ValidationCode) =>
        ctx.addIssue({ code: "custom", path: ["variants", index, field], message });
      if (variant.sku) {
        const key = variant.sku.toLowerCase();
        if (seen.sku.has(key)) flag("sku", "duplicate");
        seen.sku.set(key, index);
      }
      if (variant.pluCode) {
        if (seen.plu.has(variant.pluCode)) flag("pluCode", "duplicate");
        seen.plu.set(variant.pluCode, index);
      }
      variant.barcodes.forEach((code, b) => {
        if (barcodes.has(code)) {
          ctx.addIssue({
            code: "custom",
            path: ["variants", index, "barcodes", b],
            message: "duplicate",
          });
        }
        barcodes.set(code, index);
      });
      // Each option a product declares must be set on every variant, to one of its values.
      const values = [variant.option1, variant.option2, variant.option3];
      product.options.forEach((option, o) => {
        const value = values[o];
        if (!value || !option.values.includes(value)) flag(`option${o + 1}`, "invalid");
      });
      values.slice(product.options.length).forEach((value, extra) => {
        if (value) flag(`option${product.options.length + extra + 1}`, "invalid");
      });
      if (product.options.length > 0) {
        const combo = values.slice(0, product.options.length).join(" / ");
        if (combos.has(combo)) flag("option1", "duplicate");
        combos.add(combo);
      }
    });
  });
export type ProductInput = z.output<typeof productInputSchema>;
export type ProductFormValues = z.input<typeof productInputSchema>;

/** Display name of a variant: its own name, its option values, or the product's name. */
export function variantLabel(
  productName: string,
  variant: {
    name?: string | null;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
  },
): string {
  const options = [variant.option1, variant.option2, variant.option3].filter(Boolean).join(" / ");
  const suffix = variant.name || options;
  return suffix ? `${productName} — ${suffix}` : productName;
}
