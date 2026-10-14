import { formatMoney } from "@/domain/money";

// Kept out of the "use client" lines editor so server pages can call these too.

/** Plain decimal text for an input (no digit grouping): 1250 -> "1.25". */
export function qtyText(qtyMilli: number): string {
  return String(qtyMilli / 1000);
}

/** Tugrug text for an input, e.g. "12,500.50". */
export function costText(cost: bigint): string {
  return formatMoney(cost, { symbol: false, locale: "en" });
}
