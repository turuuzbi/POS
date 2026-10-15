/**
 * Derived sale status (pure). Sales, voids and refunds are append-only, so a
 * sale never "changes status": the status is a function of the rows around it.
 *
 *   voided             a SaleVoid exists (a void is only possible with no refunds)
 *   refunded           Σ Refund.totalAmount >= Sale.totalAmount
 *   partially refunded 0 < Σ refunds < sale total
 *   completed          none of the above
 *
 * The refund that completes a sale returns everything still held (tip and
 * rounding included), so Σ refunds equals the sale total exactly when every
 * line is back; comparing totals is therefore enough (see shifts-refunds-domain.md).
 * The list query computes the same thing in SQL; `SALE_STATUSES` is the
 * shared vocabulary and `deriveSaleStatus` the tested reference.
 */
import type { Money } from "./money";

export const SALE_STATUSES = ["COMPLETED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export function isSaleStatus(value: unknown): value is SaleStatus {
  return typeof value === "string" && (SALE_STATUSES as readonly string[]).includes(value);
}

export interface SaleStatusInput {
  /** A SaleVoid row exists for the sale. */
  voided: boolean;
  saleTotal: Money;
  /** Total amount of each Refund against the sale. */
  refundTotals: readonly Money[];
}

export function deriveSaleStatus(input: SaleStatusInput): SaleStatus {
  if (input.voided) return "VOIDED";
  if (input.refundTotals.length === 0) return "COMPLETED";
  const refunded = input.refundTotals.reduce((a, b) => a + b, 0n);
  return refunded >= input.saleTotal ? "REFUNDED" : "PARTIALLY_REFUNDED";
}

/** Refund state of a sale for the receipt banner (a voided sale has none). */
export type RefundState = "NONE" | "PARTIAL" | "FULL";

export function refundState(saleTotal: Money, refundTotals: readonly Money[]): RefundState {
  const status = deriveSaleStatus({ voided: false, saleTotal, refundTotals });
  return status === "REFUNDED" ? "FULL" : status === "PARTIALLY_REFUNDED" ? "PARTIAL" : "NONE";
}
