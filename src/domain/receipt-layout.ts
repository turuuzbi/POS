/**
 * Receipt layout (pure): `ReceiptModel` + labels -> a flat list of rows.
 * The HTML component and the PDF renderer both draw these rows, so the two
 * outputs can never disagree about content.
 */
import { formatMoney } from "./money";
import { formatQty, UNITS, type Unit } from "./qty";
import {
  RECEIPT_PAYMENT_METHODS,
  type ReceiptModel,
  type ReceiptPaymentMethod,
  type ReceiptTaxRow,
} from "./receipt";

export type ReceiptRow =
  | {
      kind: "text";
      text: string;
      align?: "left" | "center";
      bold?: boolean;
      size?: "sm" | "md" | "lg";
    }
  | {
      kind: "pair";
      left: string;
      right: string;
      bold?: boolean;
      size?: "sm" | "md" | "lg";
      indent?: boolean;
    }
  | { kind: "rule"; style: "solid" | "dashed" }
  | { kind: "gap" }
  | { kind: "banner"; text: string };

export interface ReceiptLabels {
  receiptNo: string;
  date: string;
  cashier: string;
  taxId: string;
  buyerTaxId: string;
  phone: string;
  subtotal: string;
  discount: string;
  lineDiscount: string;
  vatRate: (rate: string) => string;
  vatZero: string;
  vatExempt: string;
  cityTaxRate: (rate: string) => string;
  net: string;
  tip: string;
  rounding: string;
  total: string;
  tendered: string;
  change: string;
  voided: string;
  lottery: string;
  fiscalPending: string;
  fiscalFailed: string;
  fiscalCancelled: string;
  defaultFooter: string;
  method: Record<ReceiptPaymentMethod, string>;
  unit: Record<Unit, string>;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Builds labels from a translator scoped to the `receipt` namespace. */
export function makeReceiptLabels(t: Translate): ReceiptLabels {
  return {
    receiptNo: t("receiptNo"),
    date: t("date"),
    cashier: t("cashier"),
    taxId: t("taxId"),
    buyerTaxId: t("buyerTaxId"),
    phone: t("phone"),
    subtotal: t("subtotal"),
    discount: t("discount"),
    lineDiscount: t("lineDiscount"),
    vatRate: (rate) => t("vatRate", { rate }),
    vatZero: t("vatZero"),
    vatExempt: t("vatExempt"),
    cityTaxRate: (rate) => t("cityTaxRate", { rate }),
    net: t("net"),
    tip: t("tip"),
    rounding: t("rounding"),
    total: t("total"),
    tendered: t("tendered"),
    change: t("change"),
    voided: t("voided"),
    lottery: t("lottery"),
    fiscalPending: t("fiscalPending"),
    fiscalFailed: t("fiscalFailed"),
    fiscalCancelled: t("fiscalCancelled"),
    defaultFooter: t("defaultFooter"),
    method: Object.fromEntries(
      RECEIPT_PAYMENT_METHODS.map((m) => [m, t(`method.${m}`)]),
    ) as ReceiptLabels["method"],
    unit: Object.fromEntries(UNITS.map((u) => [u, t(`unit.${u}`)])) as ReceiptLabels["unit"],
  };
}

/** `1000` bps -> `"10"`, `150` -> `"1.5"`. */
export function formatRateBps(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bps / 100);
}

function taxLabel(row: ReceiptTaxRow, labels: ReceiptLabels, locale: string): string | null {
  if (row.treatment === "EXEMPT") return labels.vatExempt;
  if (row.treatment === "ZERO_RATED") return labels.vatZero;
  return labels.vatRate(formatRateBps(row.vatRateBps, locale));
}

export function buildReceiptRows(
  model: ReceiptModel,
  labels: ReceiptLabels,
  { locale }: { locale: string },
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const plain = (amount: bigint) => formatMoney(amount, { locale, symbol: false });
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const signed = (amount: bigint) => (amount > 0n ? `+${money(amount)}` : money(amount));
  const { header } = model;

  // Header
  if (header.businessName) {
    rows.push({ kind: "text", text: header.businessName, align: "center", bold: true, size: "lg" });
  }
  if (header.legalName && header.legalName !== header.businessName) {
    rows.push({ kind: "text", text: header.legalName, align: "center", size: "sm" });
  }
  if (header.locationName && header.locationName !== header.businessName) {
    rows.push({ kind: "text", text: header.locationName, align: "center", bold: true });
  }
  if (header.address) {
    rows.push({ kind: "text", text: header.address, align: "center", size: "sm" });
  }
  if (header.phones.length > 0) {
    rows.push({
      kind: "text",
      text: `${labels.phone}: ${header.phones.join(", ")}`,
      align: "center",
      size: "sm",
    });
  }
  if (header.email) rows.push({ kind: "text", text: header.email, align: "center", size: "sm" });
  if (header.taxId) {
    rows.push({
      kind: "text",
      text: `${labels.taxId}: ${header.taxId}`,
      align: "center",
      size: "sm",
    });
  }
  for (const text of header.text) {
    rows.push({ kind: "text", text, align: "center", size: "sm" });
  }

  if (model.voided) {
    rows.push({ kind: "gap" }, { kind: "banner", text: labels.voided });
  }

  // Meta
  rows.push({ kind: "rule", style: "dashed" });
  rows.push({ kind: "pair", left: labels.receiptNo, right: model.number, bold: true });
  rows.push({ kind: "pair", left: labels.date, right: `${model.date} ${model.time}` });
  rows.push({ kind: "pair", left: labels.cashier, right: model.cashier });
  if (model.buyerTaxId) {
    rows.push({ kind: "pair", left: labels.buyerTaxId, right: model.buyerTaxId });
  }
  rows.push({ kind: "rule", style: "dashed" });

  // Lines
  for (const line of model.lines) {
    rows.push({ kind: "text", text: `${line.no}. ${line.name}`, bold: true });
    rows.push({
      kind: "pair",
      left: `${formatQty(line.qtyMilli, line.unit, { locale })} ${labels.unit[line.unit]} × ${plain(line.unitPrice)}`,
      right: plain(line.total),
      indent: true,
    });
    for (const modifier of line.modifiers) {
      rows.push({
        kind: "pair",
        left: `+ ${modifier.name}`,
        right: modifier.priceDelta === 0n ? "" : plain(modifier.priceDelta),
        indent: true,
        size: "sm",
      });
    }
    if (line.discount > 0n) {
      rows.push({
        kind: "pair",
        left: labels.lineDiscount,
        right: `-${plain(line.discount)}`,
        indent: true,
        size: "sm",
      });
    }
    if (line.note) {
      rows.push({ kind: "text", text: line.note, size: "sm" });
    }
  }
  rows.push({ kind: "rule", style: "dashed" });

  // Summary
  const { totals } = model;
  rows.push({ kind: "pair", left: labels.subtotal, right: money(totals.items) });
  if (totals.discount > 0n) {
    rows.push({
      kind: "pair",
      left: labels.discount,
      right: `-${money(totals.discount)}`,
      size: "sm",
    });
  }
  if (totals.tip > 0n) {
    rows.push({ kind: "pair", left: labels.tip, right: money(totals.tip) });
  }
  if (totals.rounding !== 0n) {
    rows.push({ kind: "pair", left: labels.rounding, right: signed(totals.rounding) });
  }
  rows.push({
    kind: "pair",
    left: labels.total,
    right: money(totals.total),
    bold: true,
    size: "lg",
  });
  rows.push({ kind: "rule", style: "dashed" });

  // Tax
  for (const row of model.taxRows) {
    const label = taxLabel(row, labels, locale);
    if (label) {
      const amount = row.treatment === "STANDARD" ? row.vat : row.base;
      rows.push({ kind: "pair", left: label, right: money(amount), size: "sm" });
    }
    if (row.cityTax > 0n) {
      rows.push({
        kind: "pair",
        left: labels.cityTaxRate(formatRateBps(row.cityTaxRateBps, locale)),
        right: money(row.cityTax),
        size: "sm",
      });
    }
  }
  rows.push({ kind: "pair", left: labels.net, right: money(totals.net), size: "sm" });

  // Tenders
  if (model.tenders.length > 0) {
    rows.push({ kind: "rule", style: "dashed" });
    for (const tender of model.tenders) {
      const name = tender.detail
        ? `${labels.method[tender.method]} (${tender.detail})`
        : labels.method[tender.method];
      rows.push({ kind: "pair", left: name, right: money(tender.amount) });
      if (tender.tendered !== null && tender.change > 0n) {
        rows.push({
          kind: "pair",
          left: labels.tendered,
          right: money(tender.tendered),
          indent: true,
          size: "sm",
        });
      }
    }
    if (model.changeTotal > 0n) {
      rows.push({
        kind: "pair",
        left: labels.change,
        right: money(model.changeTotal),
        bold: true,
      });
    }
  }

  // Fiscal (eBarimt) placeholders. TODO(ebarimt): lottery number + QR from the PosAPI.
  rows.push({ kind: "rule", style: "dashed" });
  switch (model.fiscal.status) {
    case "ISSUED":
      if (model.fiscal.lotteryCode) {
        rows.push({
          kind: "text",
          text: `${labels.lottery}: ${model.fiscal.lotteryCode}`,
          align: "center",
          bold: true,
        });
      }
      break;
    case "FAILED":
      rows.push({ kind: "text", text: labels.fiscalFailed, align: "center", size: "sm" });
      break;
    case "CANCELLED":
      rows.push({ kind: "text", text: labels.fiscalCancelled, align: "center", size: "sm" });
      break;
    default:
      rows.push({ kind: "text", text: labels.fiscalPending, align: "center", size: "sm" });
  }

  // Note + footer
  if (model.note) rows.push({ kind: "text", text: model.note, size: "sm" });
  rows.push({ kind: "gap" });
  const footer = model.footer.length > 0 ? model.footer : [labels.defaultFooter];
  for (const text of footer) rows.push({ kind: "text", text, align: "center" });

  return rows;
}
