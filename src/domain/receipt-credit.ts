/**
 * Credit-note models (pure): the customer slip for a refund / exchange and
 * the slip for a voided sale. Like `receipt.ts` they carry facts only (no ids,
 * costs or PINs), and the source types are narrower than the DB rows so a
 * caller cannot leak a field by accident.
 *
 * Deliberately NOT on the slip: the refund's free-text note (staff may write
 * internal remarks there). Only the reason code, which is customer-safe,
 * appears. Staff names (processed by / approved by) do appear; the sale
 * receipt already shows the cashier.
 */
import { sum, type Money } from "./money";
import type { QtyMilli, Unit } from "./qty";
import {
  buildReceiptHeader,
  cleanText,
  groupTaxRows,
  localDateTime,
  receiptFooter,
  type ReceiptFiscalStatus,
  type ReceiptModel,
  type ReceiptPaymentMethod,
  type ReceiptSource,
  type ReceiptTaxRow,
  type ReceiptTaxTreatment,
} from "./receipt";
import { DEFAULT_TIME_ZONE } from "@/i18n/config";

export const RETURN_REASONS = [
  "DEFECTIVE",
  "DAMAGED",
  "WRONG_ITEM",
  "NOT_AS_DESCRIBED",
  "CHANGED_MIND",
  "OTHER",
] as const;
export type ReturnReasonCode = (typeof RETURN_REASONS)[number];

export const VOID_REASONS = [
  "ENTRY_ERROR",
  "CUSTOMER_CANCELLED",
  "PAYMENT_PROBLEM",
  "OTHER",
] as const;
export type VoidReasonCode = (typeof VOID_REASONS)[number];

interface SlipLineSource {
  lineNo: number;
  name: string;
  sku?: string | null;
  unit: Unit;
  qtyMilli: QtyMilli;
  /** Price per unit on the original sale. */
  unitPrice: Money;
  taxTreatment: ReceiptTaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  netAmount: Money;
  vatAmount: Money;
  cityTaxAmount: Money;
  totalAmount: Money;
}

export interface RefundReceiptSource {
  business: ReceiptSource["business"];
  location: ReceiptSource["location"];
  refund: {
    number: string;
    occurredAt: Date;
    processedByName: string;
    approvedByName?: string | null;
    reason: ReturnReasonCode;
    netAmount: Money;
    vatAmount: Money;
    cityTaxAmount: Money;
    tipAmount: Money;
    roundingAmount: Money;
    totalAmount: Money;
  };
  originalSale: { number: string };
  /** Number of the replacement sale when this refund is an exchange. */
  exchangeSale?: { number: string } | null;
  lines: readonly (SlipLineSource & { restock: boolean })[];
  /** RefundPayment rows. */
  payments: readonly {
    method: ReceiptPaymentMethod;
    amount: Money;
    reference?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
  }[];
  fiscal?: { status: ReceiptFiscalStatus } | null;
}

export interface RefundReceiptLine {
  no: number;
  name: string;
  sku: string | null;
  unit: Unit;
  /** Quantity taken back (not the quantity sold). */
  qtyMilli: QtyMilli;
  unitPrice: Money;
  /** Amount refunded for the line, incl. tax. */
  total: Money;
  restock: boolean;
}

export interface CreditPayout {
  method: ReceiptPaymentMethod;
  amount: Money;
  detail: string | null;
}

export interface RefundReceiptModel {
  kind: "REFUND";
  header: ReceiptModel["header"];
  number: string;
  originalNumber: string;
  exchangeNumber: string | null;
  date: string;
  time: string;
  timeZone: string;
  processedBy: string;
  approvedBy: string | null;
  reason: ReturnReasonCode;
  lines: RefundReceiptLine[];
  /** Tax reversal, one row per (treatment, rates) group of the refunded lines. */
  taxRows: ReceiptTaxRow[];
  totals: {
    items: Money;
    net: Money;
    vat: Money;
    cityTax: Money;
    tip: Money;
    rounding: Money;
    total: Money;
  };
  /** Money going back to the customer, by method (excludes exchange credit). */
  payouts: CreditPayout[];
  /** Cash handed back (the CASH payouts). */
  cashReturned: Money;
  /** Value carried into the replacement sale of an exchange. */
  exchangeCredit: Money;
  /**
   * TODO(ebarimt): the fiscal return (`issueReturn`) carries its own document
   * number once the real PosAPI is wired; until then the status picks a placeholder.
   */
  fiscal: { status: ReceiptFiscalStatus | "NONE" };
  footer: string[];
}

function cardDetail(p: {
  reference?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
}): string | null {
  const brand = cleanText(p.cardBrand);
  const last4 = cleanText(p.cardLast4);
  const card =
    brand && last4 ? `${brand} ****${last4}` : brand ? brand : last4 ? `****${last4}` : null;
  return card ?? cleanText(p.reference);
}

export function buildRefundReceiptModel(source: RefundReceiptSource): RefundReceiptModel {
  const { refund } = source;
  const timezone = cleanText(source.location.timezone) ?? DEFAULT_TIME_ZONE;
  const when = localDateTime(refund.occurredAt, timezone);
  const sorted = [...source.lines].sort((a, b) => a.lineNo - b.lineNo);

  const payouts: CreditPayout[] = source.payments
    .filter((p) => p.method !== "EXCHANGE_CREDIT")
    .map((p) => ({ method: p.method, amount: p.amount, detail: cardDetail(p) }));
  const exchangeCredit = sum(
    source.payments.filter((p) => p.method === "EXCHANGE_CREDIT").map((p) => p.amount),
  );

  return {
    kind: "REFUND",
    header: buildReceiptHeader(source.business, source.location),
    number: refund.number,
    originalNumber: source.originalSale.number,
    exchangeNumber: source.exchangeSale?.number ?? null,
    date: when.date,
    time: when.time,
    timeZone: when.timeZone,
    processedBy: refund.processedByName,
    approvedBy: cleanText(refund.approvedByName),
    reason: refund.reason,
    lines: sorted.map((line) => ({
      no: line.lineNo,
      name: line.name,
      sku: cleanText(line.sku),
      unit: line.unit,
      qtyMilli: line.qtyMilli,
      unitPrice: line.unitPrice,
      total: line.totalAmount,
      restock: line.restock,
    })),
    taxRows: groupTaxRows(sorted),
    totals: {
      items: sum(sorted.map((l) => l.totalAmount)),
      net: refund.netAmount,
      vat: refund.vatAmount,
      cityTax: refund.cityTaxAmount,
      tip: refund.tipAmount,
      rounding: refund.roundingAmount,
      total: refund.totalAmount,
    },
    payouts,
    cashReturned: sum(payouts.filter((p) => p.method === "CASH").map((p) => p.amount)),
    exchangeCredit,
    fiscal: { status: source.fiscal?.status ?? "NONE" },
    footer: receiptFooter(source.business),
  };
}

// ── Voided sale slip ────────────────────────────────────────────────────

export interface VoidReceiptSource {
  business: ReceiptSource["business"];
  location: ReceiptSource["location"];
  sale: {
    number: string;
    occurredAt: Date;
    cashierName: string;
    totalAmount: Money;
    netAmount: Money;
    vatAmount: Money;
    cityTaxAmount: Money;
  };
  void: {
    occurredAt: Date;
    reason: VoidReasonCode;
    voidedByName: string;
    approvedByName?: string | null;
  };
  lines: readonly SlipLineSource[];
  /** The sale's tenders; each is reversed in full by a void. */
  payments: readonly {
    method: ReceiptPaymentMethod;
    amount: Money;
    reference?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
  }[];
  fiscal?: { status: ReceiptFiscalStatus } | null;
}

export interface VoidReceiptModel {
  kind: "VOID";
  header: ReceiptModel["header"];
  /** Number of the voided sale. */
  number: string;
  saleDate: string;
  saleTime: string;
  voidDate: string;
  voidTime: string;
  timeZone: string;
  cashier: string;
  voidedBy: string;
  approvedBy: string | null;
  reason: VoidReasonCode;
  lines: RefundReceiptLine[];
  taxRows: ReceiptTaxRow[];
  totals: { net: Money; vat: Money; cityTax: Money; total: Money };
  /** Tenders returned / reversed, by method. */
  reversals: CreditPayout[];
  cashReturned: Money;
  fiscal: { status: ReceiptFiscalStatus | "NONE" };
  footer: string[];
}

export function buildVoidReceiptModel(source: VoidReceiptSource): VoidReceiptModel {
  const timezone = cleanText(source.location.timezone) ?? DEFAULT_TIME_ZONE;
  const sale = localDateTime(source.sale.occurredAt, timezone);
  const voided = localDateTime(source.void.occurredAt, timezone);
  const sorted = [...source.lines].sort((a, b) => a.lineNo - b.lineNo);
  const reversals: CreditPayout[] = source.payments.map((p) => ({
    method: p.method,
    amount: p.amount,
    detail: cardDetail(p),
  }));
  return {
    kind: "VOID",
    header: buildReceiptHeader(source.business, source.location),
    number: source.sale.number,
    saleDate: sale.date,
    saleTime: sale.time,
    voidDate: voided.date,
    voidTime: voided.time,
    timeZone: voided.timeZone,
    cashier: source.sale.cashierName,
    voidedBy: source.void.voidedByName,
    approvedBy: cleanText(source.void.approvedByName),
    reason: source.void.reason,
    lines: sorted.map((line) => ({
      no: line.lineNo,
      name: line.name,
      sku: cleanText(line.sku),
      unit: line.unit,
      qtyMilli: line.qtyMilli,
      unitPrice: line.unitPrice,
      total: line.totalAmount,
      restock: false,
    })),
    taxRows: groupTaxRows(sorted),
    totals: {
      net: source.sale.netAmount,
      vat: source.sale.vatAmount,
      cityTax: source.sale.cityTaxAmount,
      total: source.sale.totalAmount,
    },
    reversals,
    cashReturned: sum(reversals.filter((p) => p.method === "CASH").map((p) => p.amount)),
    fiscal: { status: source.fiscal?.status ?? "NONE" },
    footer: receiptFooter(source.business),
  };
}
