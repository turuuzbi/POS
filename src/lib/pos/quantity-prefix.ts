import { parseQty } from "@/domain/qty";

/** "3*4901234567890" -> 3 pieces of that code (quantity prefix typed or scanned). */
export function parseQuantityPrefix(raw: string): { qtyMilli: number; code: string } | null {
  const match = /^(\d+(?:[.,]\d{1,3})?)\s*[*xх×]\s*(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const qty = parseQty(match[1]!, "KG"); // any positive milli value; the cart validates per unit
  return qty === null ? null : { qtyMilli: qty, code: match[2]!.trim() };
}
