/**
 * Quantities are integers in thousandths of the product's unit ("milli"):
 * 1 piece = 1000, 1.250 kg = 1250. This keeps weighed goods integer-only and
 * lets one code path serve pieces, kilograms, litres and metres.
 */
import { divRound, type Money, type RoundingMode } from "./money";

export type QtyMilli = number;

export const MILLI_PER_UNIT = 1000;
const MILLI_BIG = 1000n;
/** Upper bound for a single line/movement quantity (fits Int4 with headroom). */
export const MAX_QTY_MILLI = 1_000_000_000; // 1 000 000 units

export const UNITS = ["PIECE", "KG", "LITER", "METER"] as const;
export type Unit = (typeof UNITS)[number];

/** Units that can be sold in fractions (weighed / measured goods). */
export function isFractionalUnit(unit: Unit): boolean {
  return unit !== "PIECE";
}

export function isValidQty(qtyMilli: number, unit: Unit): boolean {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0 || qtyMilli > MAX_QTY_MILLI) return false;
  return isFractionalUnit(unit) || qtyMilli % MILLI_PER_UNIT === 0;
}

/** Whole units → milli (integers only). */
export function units(count: number): QtyMilli {
  if (!Number.isSafeInteger(count))
    throw new RangeError(`units: expected an integer, got ${count}`);
  return count * MILLI_PER_UNIT;
}

const QTY_INPUT = /^(\d+)(?:[.,](\d{1,3}))?$/;

/**
 * Parse a typed quantity ("2", "1.25", "0,750") into milli units. Both "."
 * and "," are accepted as the decimal mark: quantities never use digit
 * grouping, so there is no ambiguity. Pieces must be whole.
 * Returns null when invalid for the unit.
 */
export function parseQty(input: string, unit: Unit): QtyMilli | null {
  const match = QTY_INPUT.exec(input.trim());
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  const qtyMilli = Number(whole) * MILLI_PER_UNIT + Number(fraction.padEnd(3, "0") || "0");
  return isValidQty(qtyMilli, unit) ? qtyMilli : null;
}

/**
 * Format milli units for display: pieces as integers, measured units with up
 * to 3 decimals (trailing zeros trimmed unless `fixedDecimals`).
 */
export function formatQty(
  qtyMilli: QtyMilli,
  unit: Unit,
  { locale = "mn", fixedDecimals = false }: { locale?: string; fixedDecimals?: boolean } = {},
): string {
  const fractional = isFractionalUnit(unit);
  const value = qtyMilli / MILLI_PER_UNIT; // display only — never fed back into math
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractional && fixedDecimals ? 3 : 0,
    maximumFractionDigits: fractional ? 3 : 0,
  }).format(value);
}

/**
 * Price for a quantity: `unitPrice × qtyMilli / 1000`, rounded once.
 * `unitPrice` is per whole unit (per piece, per kg, …).
 */
export function extend(
  unitPrice: Money,
  qtyMilli: QtyMilli,
  mode: RoundingMode = "HALF_UP",
): Money {
  if (!Number.isSafeInteger(qtyMilli)) throw new RangeError("extend: qtyMilli must be an integer");
  return divRound(unitPrice * BigInt(qtyMilli), MILLI_BIG, mode);
}
