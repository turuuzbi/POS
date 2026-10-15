/**
 * Credit-note layout (pure): refund / void models + labels -> the same flat
 * `ReceiptRow` list the sale receipt uses, so the HTML slip (80/58 mm) and the
 * PDF draw it with the very same components and cannot disagree.
 *
 * Amounts that go back to the customer are printed with a leading minus.
 */
import { formatMoney } from "./money";
import { formatQty } from "./qty";
import type { CreditPayout, RefundReceiptModel, VoidReceiptModel } from "./receipt-credit";
import { RETURN_REASONS, VOID_REASONS } from "./receipt-credit";
import {
  buildHeaderRows,
  formatRateBps,
  makeReceiptLabels,
  type ReceiptLabels,
  type ReceiptRow,
} from "./receipt-layout";
import type { ReceiptFiscalStatus, ReceiptTaxRow } from "./receipt";

export interface CreditLabels extends ReceiptLabels {
  refundTitle: string;
  voidTitle: string;
  originalReceiptNo: string;
  refundNo: string;
  exchangeSaleNo: string;
  voidDate: string;
  saleDate: string;
  reason: string;
  processedBy: string;
  voidedBy: string;
  approvedBy: string;
  refundedItems: string;
  refundedTotal: string;
  voidedTotal: string;
  taxReversal: string;
  payoutsHeading: string;
  reversalsHeading: string;
  cashReturned: string;
  exchangeCredit: string;
  fiscalReturnPending: string;
  fiscalReturnFailed: string;
  fiscalReturnCancelled: string;
  fiscalReturnIssued: string;
  returnReason: Record<(typeof RETURN_REASONS)[number], string>;
  voidReason: Record<(typeof VOID_REASONS)[number], string>;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Labels from a translator scoped to the `receipt` namespace. */
export function makeCreditLabels(t: Translate): CreditLabels {
  return {
    ...makeReceiptLabels(t),
    refundTitle: t("refund.title"),
    voidTitle: t("voidSlip.title"),
    originalReceiptNo: t("refund.originalReceiptNo"),
    refundNo: t("refund.refundNo"),
    exchangeSaleNo: t("refund.exchangeSaleNo"),
    voidDate: t("voidSlip.voidDate"),
    saleDate: t("voidSlip.saleDate"),
    reason: t("refund.reason"),
    processedBy: t("refund.processedBy"),
    voidedBy: t("voidSlip.voidedBy"),
    approvedBy: t("refund.approvedBy"),
    refundedItems: t("refund.refundedItems"),
    refundedTotal: t("refund.refundedTotal"),
    voidedTotal: t("voidSlip.voidedTotal"),
    taxReversal: t("refund.taxReversal"),
    payoutsHeading: t("refund.payoutsHeading"),
    reversalsHeading: t("voidSlip.reversalsHeading"),
    cashReturned: t("refund.cashReturned"),
    exchangeCredit: t("refund.exchangeCredit"),
    fiscalReturnPending: t("refund.fiscalPending"),
    fiscalReturnFailed: t("refund.fiscalFailed"),
    fiscalReturnCancelled: t("refund.fiscalCancelled"),
    fiscalReturnIssued: t("refund.fiscalIssued"),
    returnReason: Object.fromEntries(
      RETURN_REASONS.map((r) => [r, t(`refund.reasons.${r}`)]),
    ) as CreditLabels["returnReason"],
    voidReason: Object.fromEntries(
      VOID_REASONS.map((r) => [r, t(`voidSlip.reasons.${r}`)]),
    ) as CreditLabels["voidReason"],
  };
}

function taxReversalRows(
  taxRows: readonly ReceiptTaxRow[],
  labels: CreditLabels,
  locale: string,
): ReceiptRow[] {
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const rows: ReceiptRow[] = [];
  for (const row of taxRows) {
    const label =
      row.treatment === "EXEMPT"
        ? labels.vatExempt
        : row.treatment === "ZERO_RATED"
          ? labels.vatZero
          : labels.vatRate(formatRateBps(row.vatRateBps, locale));
    const amount = row.treatment === "STANDARD" ? row.vat : row.base;
    rows.push({ kind: "pair", left: label, right: `-${money(amount)}`, size: "sm" });
    if (row.cityTax > 0n) {
      rows.push({
        kind: "pair",
        left: labels.cityTaxRate(formatRateBps(row.cityTaxRateBps, locale)),
        right: `-${money(row.cityTax)}`,
        size: "sm",
      });
    }
  }
  return rows;
}

function payoutRows(
  payouts: readonly CreditPayout[],
  labels: CreditLabels,
  locale: string,
): ReceiptRow[] {
  const money = (amount: bigint) => formatMoney(amount, { locale });
  return payouts.map((p) => ({
    kind: "pair" as const,
    left: p.detail ? `${labels.method[p.method]} (${p.detail})` : labels.method[p.method],
    right: money(p.amount),
  }));
}

/**
 * TODO(ebarimt): a real fiscal return prints the return document number from
 * the PosAPI; for now every status maps to a plain-text placeholder.
 */
function fiscalReturnRow(status: ReceiptFiscalStatus | "NONE", labels: CreditLabels): ReceiptRow {
  const text =
    status === "ISSUED"
      ? labels.fiscalReturnIssued
      : status === "FAILED"
        ? labels.fiscalReturnFailed
        : status === "CANCELLED"
          ? labels.fiscalReturnCancelled
          : labels.fiscalReturnPending;
  return { kind: "text", text, align: "center", size: "sm" };
}

export function buildRefundReceiptRows(
  model: RefundReceiptModel,
  labels: CreditLabels,
  { locale }: { locale: string },
): ReceiptRow[] {
  const plain = (amount: bigint) => formatMoney(amount, { locale, symbol: false });
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const signed = (amount: bigint) => (amount > 0n ? `+${money(amount)}` : money(amount));
  const rows: ReceiptRow[] = [...buildHeaderRows(model.header, labels)];

  rows.push({ kind: "gap" }, { kind: "banner", text: labels.refundTitle });
  rows.push({ kind: "rule", style: "dashed" });
  rows.push({ kind: "pair", left: labels.refundNo, right: model.number, bold: true });
  rows.push({ kind: "pair", left: labels.originalReceiptNo, right: model.originalNumber });
  if (model.exchangeNumber) {
    rows.push({ kind: "pair", left: labels.exchangeSaleNo, right: model.exchangeNumber });
  }
  rows.push({ kind: "pair", left: labels.date, right: `${model.date} ${model.time}` });
  rows.push({ kind: "pair", left: labels.processedBy, right: model.processedBy });
  if (model.approvedBy) {
    rows.push({ kind: "pair", left: labels.approvedBy, right: model.approvedBy });
  }
  rows.push({ kind: "pair", left: labels.reason, right: labels.returnReason[model.reason] });
  rows.push({ kind: "rule", style: "dashed" });

  for (const line of model.lines) {
    rows.push({ kind: "text", text: `${line.no}. ${line.name}`, bold: true });
    rows.push({
      kind: "pair",
      left: `${formatQty(line.qtyMilli, line.unit, { locale })} ${labels.unit[line.unit]} × ${plain(line.unitPrice)}`,
      right: `-${plain(line.total)}`,
      indent: true,
    });
  }
  rows.push({ kind: "rule", style: "dashed" });

  const { totals } = model;
  rows.push({ kind: "pair", left: labels.refundedItems, right: `-${money(totals.items)}` });
  if (totals.tip > 0n) {
    rows.push({ kind: "pair", left: labels.tip, right: `-${money(totals.tip)}` });
  }
  if (totals.rounding !== 0n) {
    rows.push({ kind: "pair", left: labels.rounding, right: signed(totals.rounding) });
  }
  rows.push({
    kind: "pair",
    left: labels.refundedTotal,
    right: `-${money(totals.total)}`,
    bold: true,
    size: "lg",
  });
  rows.push({ kind: "rule", style: "dashed" });

  rows.push({ kind: "text", text: labels.taxReversal, size: "sm", bold: true });
  rows.push(...taxReversalRows(model.taxRows, labels, locale));
  rows.push({ kind: "pair", left: labels.net, right: `-${money(totals.net)}`, size: "sm" });

  if (model.payouts.length > 0 || model.exchangeCredit > 0n) {
    rows.push({ kind: "rule", style: "dashed" });
    rows.push({ kind: "text", text: labels.payoutsHeading, size: "sm", bold: true });
    rows.push(...payoutRows(model.payouts, labels, locale));
    if (model.exchangeCredit > 0n) {
      rows.push({ kind: "pair", left: labels.exchangeCredit, right: money(model.exchangeCredit) });
    }
    if (model.cashReturned > 0n) {
      rows.push({
        kind: "pair",
        left: labels.cashReturned,
        right: money(model.cashReturned),
        bold: true,
      });
    }
  }

  rows.push({ kind: "rule", style: "dashed" }, fiscalReturnRow(model.fiscal.status, labels));
  rows.push({ kind: "gap" });
  const footer = model.footer.length > 0 ? model.footer : [labels.defaultFooter];
  for (const text of footer) rows.push({ kind: "text", text, align: "center" });
  return rows;
}

export function buildVoidReceiptRows(
  model: VoidReceiptModel,
  labels: CreditLabels,
  { locale }: { locale: string },
): ReceiptRow[] {
  const plain = (amount: bigint) => formatMoney(amount, { locale, symbol: false });
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const rows: ReceiptRow[] = [...buildHeaderRows(model.header, labels)];

  rows.push({ kind: "gap" }, { kind: "banner", text: labels.voidTitle });
  rows.push({ kind: "rule", style: "dashed" });
  rows.push({ kind: "pair", left: labels.receiptNo, right: model.number, bold: true });
  rows.push({ kind: "pair", left: labels.saleDate, right: `${model.saleDate} ${model.saleTime}` });
  rows.push({ kind: "pair", left: labels.voidDate, right: `${model.voidDate} ${model.voidTime}` });
  rows.push({ kind: "pair", left: labels.cashier, right: model.cashier });
  rows.push({ kind: "pair", left: labels.voidedBy, right: model.voidedBy });
  if (model.approvedBy) {
    rows.push({ kind: "pair", left: labels.approvedBy, right: model.approvedBy });
  }
  rows.push({ kind: "pair", left: labels.reason, right: labels.voidReason[model.reason] });
  rows.push({ kind: "rule", style: "dashed" });

  for (const line of model.lines) {
    rows.push({ kind: "text", text: `${line.no}. ${line.name}`, bold: true });
    rows.push({
      kind: "pair",
      left: `${formatQty(line.qtyMilli, line.unit, { locale })} ${labels.unit[line.unit]} × ${plain(line.unitPrice)}`,
      right: plain(line.total),
      indent: true,
    });
  }
  rows.push({ kind: "rule", style: "dashed" });
  rows.push({
    kind: "pair",
    left: labels.voidedTotal,
    right: money(model.totals.total),
    bold: true,
    size: "lg",
  });
  rows.push({ kind: "rule", style: "dashed" });
  rows.push(...taxReversalRows(model.taxRows, labels, locale).map(unsign));
  rows.push({ kind: "pair", left: labels.net, right: money(model.totals.net), size: "sm" });

  if (model.reversals.length > 0) {
    rows.push({ kind: "rule", style: "dashed" });
    rows.push({ kind: "text", text: labels.reversalsHeading, size: "sm", bold: true });
    rows.push(...payoutRows(model.reversals, labels, locale));
    if (model.cashReturned > 0n) {
      rows.push({
        kind: "pair",
        left: labels.cashReturned,
        right: money(model.cashReturned),
        bold: true,
      });
    }
  }

  rows.push({ kind: "rule", style: "dashed" }, fiscalReturnRow(model.fiscal.status, labels));
  rows.push({ kind: "gap" });
  const footer = model.footer.length > 0 ? model.footer : [labels.defaultFooter];
  for (const text of footer) rows.push({ kind: "text", text, align: "center" });
  return rows;
}

/** A void slip repeats the sale's tax as it was (no minus sign). */
function unsign(row: ReceiptRow): ReceiptRow {
  return row.kind === "pair" && row.right.startsWith("-")
    ? { ...row, right: row.right.slice(1) }
    : row;
}
