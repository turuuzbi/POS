/**
 * The original sale as the Returns screen receives it: plain JSON (money as
 * decimal strings, dates as ISO text), parsed into the domain's snapshot types
 * so the client runs the SAME `planRefund` / `planVoid` the server will run.
 *
 * Costs (`unitCost`) are never sent to the register: a cashier has no business
 * seeing margins. The planner needs them only for COGS bookkeeping, which the
 * client does not display, so the snapshot carries 0 there.
 */
import { z } from "zod";
import { signedMoneyWire, uuid } from "@/domain/checkout-contract";
import { PAYMENT_METHODS, RETURN_REASONS } from "@/domain/refund";
import { lineProgress, type PreviousRefund, type RefundSaleSnapshot } from "@/domain/refund";
import type { RefundResult } from "@/domain/refund-contract";
import { UNITS } from "@/domain/qty";
import { VOID_REASONS, type VoidSaleSnapshot } from "@/domain/void";

const money = signedMoneyWire;

export const saleLineWireSchema = z.object({
  id: uuid,
  lineNo: z.number().int(),
  name: z.string(),
  sku: z.string().nullable(),
  variantId: uuid,
  unit: z.enum(UNITS),
  qtyMilli: z.number().int().positive(),
  unitPrice: money,
  totalAmount: money,
  netAmount: money,
  vatAmount: money,
  cityTaxAmount: money,
  pricesIncludeTax: z.boolean(),
  /** Product tracks stock: the default for the "restock" switch. */
  tracksStock: z.boolean(),
  isGiftCard: z.boolean(),
});

export const salePaymentWireSchema = z.object({
  id: uuid,
  method: z.enum(PAYMENT_METHODS),
  amount: money,
  change: money,
  reference: z.string().nullable(),
  cardLast4: z.string().nullable(),
});

export const previousRefundWireSchema = z.object({
  id: uuid,
  number: z.string(),
  occurredAt: z.string(),
  reason: z.enum(RETURN_REASONS),
  totalAmount: money,
  tipAmount: money,
  lines: z.array(
    z.object({
      saleLineId: uuid,
      qtyMilli: z.number().int().positive(),
      restock: z.boolean(),
      netAmount: money,
      vatAmount: money,
      cityTaxAmount: money,
      totalAmount: money,
    }),
  ),
  payments: z.array(
    z.object({
      method: z.enum(PAYMENT_METHODS),
      amount: money,
      originalPaymentId: uuid.nullable(),
    }),
  ),
});

export const returnSaleWireSchema = z.object({
  /** Sale ids are client UUIDv7s; the refund contract requires that shape. */
  id: uuid,
  number: z.string(),
  occurredAt: z.string(),
  locationId: uuid,
  registerId: uuid,
  shiftId: uuid,
  cashierName: z.string(),
  totalAmount: money,
  itemsAmount: money,
  tipAmount: money,
  roundingAmount: money,
  vatAmount: money,
  status: z.enum(["COMPLETED", "VOIDED"]),
  voided: z.object({ reason: z.enum(VOID_REASONS), at: z.string() }).nullable(),
  lines: z.array(saleLineWireSchema),
  payments: z.array(salePaymentWireSchema),
  refunds: z.array(previousRefundWireSchema),
});
export type ReturnSale = z.output<typeof returnSaleWireSchema>;
export type ReturnSaleLine = ReturnSale["lines"][number];
export type ReturnSalePayment = ReturnSale["payments"][number];
export type ReturnSaleRefund = ReturnSale["refunds"][number];

export const recentSaleWireSchema = z.object({
  id: uuid,
  number: z.string(),
  occurredAt: z.string(),
  shiftId: uuid,
  totalAmount: money,
  lineCount: z.number().int(),
  methods: z.array(z.enum(PAYMENT_METHODS)),
  /** Derived on the server from the stored rows. */
  state: z.enum(["OK", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"]),
});
export type RecentSale = z.output<typeof recentSaleWireSchema>;

export const recentSalesResultSchema = z.object({
  sales: z.array(recentSaleWireSchema),
  /** True when more rows matched than were returned. */
  truncated: z.boolean(),
});

/** Server answer of the lookup: the sale (or none) and the refund policy. */
export const returnLookupResultSchema = z.object({
  sale: returnSaleWireSchema.nullable(),
  policy: z.object({ maxRefundWindowDays: z.number().int().positive().nullable() }),
  /** The register's totals rounding unit (möngö). */
  roundingUnit: money,
});
export type ReturnLookupResult = z.output<typeof returnLookupResultSchema>;

// ---------------------------------------------------------------------------
// Wire -> domain
// ---------------------------------------------------------------------------

export function toRefundSnapshot(sale: ReturnSale): RefundSaleSnapshot {
  return {
    id: sale.id,
    status: sale.status,
    occurredAt: new Date(sale.occurredAt),
    shiftId: sale.shiftId,
    totalAmount: sale.totalAmount,
    tipAmount: sale.tipAmount,
    roundingAmount: sale.roundingAmount,
    lines: sale.lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      unit: line.unit,
      qtyMilli: line.qtyMilli,
      totalAmount: line.totalAmount,
      netAmount: line.netAmount,
      vatAmount: line.vatAmount,
      cityTaxAmount: line.cityTaxAmount,
      unitCost: 0n,
      tracksStock: line.tracksStock,
      isGiftCard: line.isGiftCard,
      pricesIncludeTax: line.pricesIncludeTax,
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: p.amount,
      change: p.change,
    })),
  };
}

export function toPreviousRefunds(sale: ReturnSale): PreviousRefund[] {
  return sale.refunds.map((refund) => ({
    id: refund.id,
    totalAmount: refund.totalAmount,
    tipAmount: refund.tipAmount,
    lines: refund.lines.map(({ restock: _restock, ...rest }) => rest),
    payments: refund.payments.map((p) => ({ ...p })),
  }));
}

export function toVoidSnapshot(sale: ReturnSale): VoidSaleSnapshot {
  return {
    id: sale.id,
    status: sale.status,
    shiftId: sale.shiftId,
    totalAmount: sale.totalAmount,
    lines: sale.lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      qtyMilli: line.qtyMilli,
      unitCost: 0n,
      tracksStock: line.tracksStock,
      isGiftCard: line.isGiftCard,
    })),
    payments: sale.payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount })),
    refundCount: sale.refunds.length,
  };
}

/**
 * A refund the sale already holds, in the shape of a fresh `RefundResult`.
 * Used after an unknown outcome: the cashier reloads the sale and, when the
 * refund id is in its history, the commit did happen and this is the receipt.
 */
export function resultFromStored(sale: ReturnSale, refundId: string): RefundResult | null {
  const refund = sale.refunds.find((r) => r.id === refundId);
  if (!refund) return null;
  const total = (pick: (l: ReturnSaleRefund["lines"][number]) => bigint) =>
    refund.lines.reduce((acc, l) => acc + pick(l), 0n);
  const itemsTotal = total((l) => l.totalAmount);
  const progress = lineProgress(toRefundSnapshot(sale), toPreviousRefunds(sale));
  return {
    refundId: refund.id,
    receiptNumber: refund.number,
    saleId: sale.id,
    totals: {
      itemsTotal,
      netAmount: total((l) => l.netAmount),
      vatAmount: total((l) => l.vatAmount),
      cityTaxAmount: total((l) => l.cityTaxAmount),
      tipAmount: refund.tipAmount,
      roundingAmount: refund.totalAmount - itemsTotal - refund.tipAmount,
      totalAmount: refund.totalAmount,
    },
    lines: refund.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      restock: l.restock,
      totalAmount: l.totalAmount,
    })),
    payments: refund.payments.map((p) => ({ ...p })),
    cashRefund: refund.payments
      .filter((p) => p.method === "CASH")
      .reduce((acc, p) => acc + p.amount, 0n),
    exchange: null,
    completesSale: progress.every((p) => p.remainingQtyMilli === 0),
    replayed: true,
  };
}
