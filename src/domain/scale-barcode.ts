/**
 * Scale-label barcodes (EAN-13 in the GS1 "restricted circulation" range,
 * prefix 2x). A label printed by a weighing scale embeds an item code (PLU)
 * and either the weight or the price:
 *
 *   2 0 | 0 0 1 2 3 | 0 1 2 5 0 | 7
 *   prefix  PLU       value       check digit
 *
 * Rules are configurable per business because scale vendors differ. Lookup
 * order at checkout: exact Barcode match first, then these rules — so
 * ordinary in-store 2x barcodes keep working.
 */
import { z } from "zod";
import { MINOR_PER_MAJOR, type Money } from "./money";
import type { QtyMilli } from "./qty";

export const EAN13_LENGTH = 13;

export const scaleBarcodeRuleSchema = z
  .object({
    /** Leading digits that identify this label format, e.g. "20". */
    prefix: z.string().regex(/^\d{1,3}$/),
    itemCodeLength: z.number().int().min(3).max(7),
    valueType: z.enum(["WEIGHT", "PRICE"]),
    valueLength: z.number().int().min(3).max(7),
    /**
     * WEIGHT: decimals of the kg value (3 = grams).
     * PRICE: decimals of the ₮ value (0 = whole tögrög).
     */
    valueDecimals: z.number().int().min(0).max(3),
  })
  .refine((r) => r.prefix.length + r.itemCodeLength + r.valueLength + 1 === EAN13_LENGTH, {
    message: "prefix + item code + value + check digit must be 13 digits",
  })
  .refine((r) => r.valueType === "WEIGHT" || r.valueDecimals <= 2, {
    message: "price values support at most 2 decimals",
  });

export type ScaleBarcodeRule = z.infer<typeof scaleBarcodeRuleSchema>;

export const scaleBarcodeRulesSchema = z.array(scaleBarcodeRuleSchema).max(20);

/** Default: prefix "20", 5-digit PLU, weight in grams. */
export const DEFAULT_SCALE_RULES: readonly ScaleBarcodeRule[] = [
  { prefix: "20", itemCodeLength: 5, valueType: "WEIGHT", valueLength: 5, valueDecimals: 3 },
];

export type ScaleBarcodeMatch =
  | { pluCode: string; kind: "WEIGHT"; qtyMilli: QtyMilli }
  | { pluCode: string; kind: "PRICE"; price: Money };

/** GS1 mod-10 check digit for the first 12 digits of an EAN-13. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new RangeError("ean13CheckDigit: expected 12 digits");
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const digit = first12.charCodeAt(i) - 48;
    total += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (total % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Strip leading zeros so "00123" and "123" name the same PLU ("0" stays "0"). */
export function normalizePlu(code: string): string {
  return code.replace(/^0+(?=\d)/, "");
}

/**
 * Parse a scanned code against the rules. Returns null when the code is not a
 * valid EAN-13, matches no rule, or encodes a zero quantity/price.
 * The longest matching prefix wins.
 */
export function parseScaleBarcode(
  code: string,
  rules: readonly ScaleBarcodeRule[] = DEFAULT_SCALE_RULES,
): ScaleBarcodeMatch | null {
  const trimmed = code.trim();
  if (!isValidEan13(trimmed)) return null;

  const rule = [...rules]
    .filter((r) => trimmed.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!rule) return null;

  const itemStart = rule.prefix.length;
  const valueStart = itemStart + rule.itemCodeLength;
  const pluCode = normalizePlu(trimmed.slice(itemStart, valueStart));
  const rawValue = BigInt(trimmed.slice(valueStart, valueStart + rule.valueLength));
  if (rawValue === 0n) return null;

  if (rule.valueType === "WEIGHT") {
    // value has `valueDecimals` decimals of kg → milli-kg (grams)
    const qtyMilli = Number(rawValue) * 10 ** (3 - rule.valueDecimals);
    return { pluCode, kind: "WEIGHT", qtyMilli };
  }
  // value has `valueDecimals` decimals of ₮ → möngö
  const price = (rawValue * MINOR_PER_MAJOR) / 10n ** BigInt(rule.valueDecimals);
  return { pluCode, kind: "PRICE", price };
}

/** Build a valid scale barcode (for tests, seed data and label printing). */
export function buildScaleBarcode(rule: ScaleBarcodeRule, pluCode: string, value: number): string {
  const item = pluCode.padStart(rule.itemCodeLength, "0");
  const encoded = String(value).padStart(rule.valueLength, "0");
  if (item.length !== rule.itemCodeLength || encoded.length !== rule.valueLength) {
    throw new RangeError("buildScaleBarcode: value does not fit the rule");
  }
  const first12 = rule.prefix + item + encoded;
  return first12 + String(ean13CheckDigit(first12));
}

/** Milli → value field for a WEIGHT rule (inverse of the parse). */
export function weightToValue(rule: ScaleBarcodeRule, qtyMilli: QtyMilli): number {
  const divisor = 10 ** (3 - rule.valueDecimals);
  if (qtyMilli % divisor !== 0) throw new RangeError("weightToValue: precision loss");
  return qtyMilli / divisor;
}
