/**
 * Voiding a sale (Phase 3, pure). A void nullifies a sale that has not left the
 * shift it was rung up in; anything later is a refund. The rules:
 *
 *  - the sale must be COMPLETED (not already voided);
 *  - it must belong to the SAME shift, and that shift must still be OPEN;
 *  - nothing may have been refunded against it;
 *  - a reason code is required (`OTHER` also needs a note);
 *  - the actor needs `pos.void`, or a manager approval bound to this sale.
 *
 * `planVoid` returns what the service must reverse: payments (per tender, with
 * the kind of reversal), stock and COGS, and whether a fiscal return is due.
 * Gift-card and exchange-credit tenders are Phase 4 stubs (NOT_SUPPORTED).
 */
import { sum, type Money } from "./money";
import { extend } from "./qty";
import type { PaymentMethod } from "./refund";

export const VOID_REASONS = [
  "ENTRY_ERROR",
  "CUSTOMER_CANCELLED",
  "PAYMENT_PROBLEM",
  "OTHER",
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const MAX_VOID_NOTE_LENGTH = 500;

export interface VoidSaleSnapshot {
  id: string;
  /** COMPLETED, or VOIDED when a SaleVoid row already exists. */
  status: "COMPLETED" | "VOIDED";
  shiftId: string;
  totalAmount: Money;
  lines: {
    id: string;
    variantId: string;
    qtyMilli: number;
    unitCost: Money;
    tracksStock?: boolean;
    isGiftCard?: boolean;
  }[];
  /** Amounts exclude change. */
  payments: { id: string; method: PaymentMethod; amount: Money }[];
  /** Number of Refund rows against this sale. */
  refundCount: number;
  /** A fiscal receipt was issued for the sale (so a fiscal return is due). */
  fiscalIssued?: boolean;
}

export interface VoidContext {
  shift: { id: string; status: "OPEN" | "CLOSED" };
  reason: VoidReason;
  note?: string | undefined;
  /** `pos.void` held by the actor, or a valid approval token for this sale. */
  grants: { void: boolean };
}

export type VoidIssueCode =
  | "SHIFT_NOT_OPEN"
  | "SALE_NOT_COMPLETED"
  | "SALE_IN_OTHER_SHIFT"
  | "HAS_REFUNDS"
  | "REASON_NOTE_REQUIRED"
  | "NOTE_TOO_LONG"
  | "NOT_SUPPORTED"
  | "APPROVAL_REQUIRED";

export interface VoidIssue {
  code: VoidIssueCode;
  details?: Record<string, string | string[]>;
}

export type PaymentReversalKind = "CASH_RETURN" | "CARD_REVERSAL" | "QPAY_REFUND" | "BANK_REVERSAL";

export interface VoidPlan {
  saleId: string;
  reason: VoidReason;
  note: string | undefined;
  totalAmount: Money;
  paymentReversals: {
    paymentId: string;
    method: PaymentMethod;
    amount: Money;
    kind: PaymentReversalKind;
  }[];
  /** Cash handed back from the drawer (already excluded from expected cash once voided). */
  cashReturned: Money;
  stockRestores: { saleLineId: string; variantId: string; qtyMilli: number; unitCost: Money }[];
  cogsReversalTotal: Money;
  fiscalReturn: boolean;
}

export type VoidPlanResult = { ok: true; plan: VoidPlan } | { ok: false; issues: VoidIssue[] };

const REVERSAL_KIND: Partial<Record<PaymentMethod, PaymentReversalKind>> = {
  CASH: "CASH_RETURN",
  CARD: "CARD_REVERSAL",
  QPAY: "QPAY_REFUND",
  BANK_TRANSFER: "BANK_REVERSAL",
};

export function planVoid(sale: VoidSaleSnapshot, context: VoidContext): VoidPlanResult {
  const issues: VoidIssue[] = [];
  const note = context.note?.trim() || undefined;

  if (sale.status !== "COMPLETED") issues.push({ code: "SALE_NOT_COMPLETED" });
  if (context.shift.status !== "OPEN") issues.push({ code: "SHIFT_NOT_OPEN" });
  else if (sale.shiftId !== context.shift.id) issues.push({ code: "SALE_IN_OTHER_SHIFT" });
  if (sale.refundCount > 0) issues.push({ code: "HAS_REFUNDS" });
  if (context.reason === "OTHER" && note === undefined)
    issues.push({ code: "REASON_NOTE_REQUIRED" });
  if (note !== undefined && note.length > MAX_VOID_NOTE_LENGTH)
    issues.push({ code: "NOTE_TOO_LONG" });

  const unsupported = new Set<string>();
  for (const payment of sale.payments) {
    if (REVERSAL_KIND[payment.method] === undefined) unsupported.add(payment.method);
  }
  if (sale.lines.some((l) => l.isGiftCard)) unsupported.add("GIFT_CARD_LINE");
  if (unsupported.size > 0) {
    issues.push({ code: "NOT_SUPPORTED", details: { what: [...unsupported] } });
  }

  if (issues.length === 0 && !context.grants.void) issues.push({ code: "APPROVAL_REQUIRED" });
  if (issues.length > 0) return { ok: false, issues };

  const paymentReversals = sale.payments.map((p) => ({
    paymentId: p.id,
    method: p.method,
    amount: p.amount,
    kind: REVERSAL_KIND[p.method]!,
  }));
  const stockRestores = sale.lines
    .filter((l) => (l.tracksStock ?? true) && !l.isGiftCard)
    .map((l) => ({
      saleLineId: l.id,
      variantId: l.variantId,
      qtyMilli: l.qtyMilli,
      unitCost: l.unitCost,
    }));
  return {
    ok: true,
    plan: {
      saleId: sale.id,
      reason: context.reason,
      note,
      totalAmount: sale.totalAmount,
      paymentReversals,
      cashReturned: sum(paymentReversals.filter((p) => p.method === "CASH").map((p) => p.amount)),
      stockRestores,
      cogsReversalTotal: sum(stockRestores.map((s) => extend(s.unitCost, s.qtyMilli))),
      fiscalReturn: sale.fiscalIssued === true,
    },
  };
}
