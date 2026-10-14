/** Stock level helpers for display and alerts (pure). */
import type { Money } from "./money";
import { extend, type QtyMilli } from "./qty";

/** At or below the reorder point; items without a reorder point never alert. */
export function isLowStock(onHandMilli: QtyMilli, reorderPointMilli: QtyMilli | null): boolean {
  return reorderPointMilli !== null && onHandMilli <= reorderPointMilli;
}

/** Stock value at average cost, rounded once. */
export function stockValue(onHandMilli: QtyMilli, avgCost: Money): Money {
  return extend(avgCost, onHandMilli);
}
