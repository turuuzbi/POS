/**
 * Receipt model builder (pure). Turns the rows of a committed sale into a
 * language-neutral, printable model: no I/O, no clock, no i18n. Text and
 * layout live in `receipt-layout.ts`; the model only carries facts.
 *
 * A receipt shows only what the customer may see: no ids, no costs, no staff
 * PINs. The source type below is deliberately narrower than the DB rows so a
 * caller cannot leak a field by accident.
 */
import { DEFAULT_TIME_ZONE } from "@/i18n/config";
import { sum, type Money } from "./money";
import type { QtyMilli, Unit } from "./qty";

export const RECEIPT_PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "QPAY",
  "BANK_TRANSFER",
  "GIFT_CARD",
  "STORE_CREDIT",
  "EXCHANGE_CREDIT",
] as const;
export type ReceiptPaymentMethod = (typeof RECEIPT_PAYMENT_METHODS)[number];

export type ReceiptTaxTreatment = "STANDARD" | "ZERO_RATED" | "EXEMPT";
export type ReceiptFiscalStatus = "PENDING" | "ISSUED" | "FAILED" | "CANCELLED";

export interface ReceiptSource {
  business: {
    name: string;
    legalName?: string | null;
    taxId?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    header?: string | null;
    footer?: string | null;
  } | null;
  location: {
    name: string;
    address?: string | null;
    phone?: string | null;
    timezone?: string | null;
    /** Overrides the business header. */
    header?: string | null;
  };
  sale: {
    number: string;
    occurredAt: Date;
    cashierName: string;
    netAmount: Money;
    vatAmount: Money;
    cityTaxAmount: Money;
    discountAmount: Money;
    itemsAmount: Money;
    tipAmount: Money;
    roundingAmount: Money;
    totalAmount: Money;
    buyerTaxId?: string | null;
    note?: string | null;
    /** A SaleVoid exists for this sale. */
    voided?: boolean;
  };
  lines: readonly {
    lineNo: number;
    name: string;
    sku?: string | null;
    unit: Unit;
    qtyMilli: QtyMilli;
    unitPrice: Money;
    taxTreatment: ReceiptTaxTreatment;
    vatRateBps: number;
    cityTaxRateBps: number;
    netAmount: Money;
    vatAmount: Money;
    cityTaxAmount: Money;
    totalAmount: Money;
    note?: string | null;
    modifiers?: readonly { name: string; priceDelta: Money }[];
  }[];
  /** Line-scoped discounts only (`saleLineNo` set); cart discounts are totals. */
  discounts: readonly {
    saleLineNo: number | null;
    amount: Money;
    reason?: string | null;
  }[];
  payments: readonly {
    method: ReceiptPaymentMethod;
    amount: Money;
    tendered?: Money | null;
    change: Money;
    reference?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
  }[];
  fiscal?: {
    status: ReceiptFiscalStatus;
    lotteryCode?: string | null;
    qrData?: string | null;
  } | null;
}

export interface ReceiptLine {
  no: number;
  name: string;
  sku: string | null;
  unit: Unit;
  qtyMilli: QtyMilli;
  unitPrice: Money;
  /** Line total incl. tax, after every discount. */
  total: Money;
  /** Discounts applied to this line directly (cart discounts are in totals). */
  discount: Money;
  modifiers: { name: string; priceDelta: Money }[];
  note: string | null;
}

export interface ReceiptTaxRow {
  treatment: ReceiptTaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  /** Σ line net amounts in this group. */
  base: Money;
  vat: Money;
  cityTax: Money;
}

export interface ReceiptTender {
  method: ReceiptPaymentMethod;
  /** Applied to the sale (excludes change). */
  amount: Money;
  tendered: Money | null;
  change: Money;
  detail: string | null;
}

export interface ReceiptModel {
  header: {
    businessName: string;
    legalName: string | null;
    locationName: string;
    address: string | null;
    phones: string[];
    email: string | null;
    taxId: string | null;
    /** Free-form header text, one entry per line. */
    text: string[];
  };
  number: string;
  /** `YYYY-MM-DD` and `HH:MM` in the location's timezone. */
  date: string;
  time: string;
  timeZone: string;
  cashier: string;
  buyerTaxId: string | null;
  voided: boolean;
  note: string | null;
  lines: ReceiptLine[];
  taxRows: ReceiptTaxRow[];
  totals: {
    items: Money;
    discount: Money;
    net: Money;
    vat: Money;
    cityTax: Money;
    tip: Money;
    rounding: Money;
    total: Money;
  };
  tenders: ReceiptTender[];
  changeTotal: Money;
  /**
   * TODO(ebarimt): lottery code and QR come from the real PosAPI response;
   * until then the status decides which placeholder the layout prints.
   */
  fiscal: {
    status: ReceiptFiscalStatus | "NONE";
    lotteryCode: string | null;
    qrData: string | null;
  };
  footer: string[];
}

/** Local `YYYY-MM-DD` / `HH:MM` for an instant, in an IANA timezone. */
export function localDateTime(
  at: Date,
  timeZone: string,
): { date: string; time: string; timeZone: string } {
  const attempt = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${get("hour")}:${get("minute")}`,
      timeZone: zone,
    };
  };
  try {
    return attempt(timeZone);
  } catch {
    return attempt(DEFAULT_TIME_ZONE);
  }
}

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const splitLines = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function buildReceiptModel(source: ReceiptSource): ReceiptModel {
  const { business, location, sale } = source;

  const lineDiscounts = new Map<number, Money>();
  for (const discount of source.discounts) {
    if (discount.saleLineNo === null) continue;
    lineDiscounts.set(
      discount.saleLineNo,
      (lineDiscounts.get(discount.saleLineNo) ?? 0n) + discount.amount,
    );
  }

  const sortedLines = [...source.lines].sort((a, b) => a.lineNo - b.lineNo);
  const lines: ReceiptLine[] = sortedLines.map((line) => ({
    no: line.lineNo,
    name: line.name,
    sku: clean(line.sku),
    unit: line.unit,
    qtyMilli: line.qtyMilli,
    unitPrice: line.unitPrice,
    total: line.totalAmount,
    discount: lineDiscounts.get(line.lineNo) ?? 0n,
    modifiers: (line.modifiers ?? []).map((m) => ({ name: m.name, priceDelta: m.priceDelta })),
    note: clean(line.note),
  }));

  // Tax breakdown: one row per distinct (treatment, VAT rate, city rate).
  const groups = new Map<string, ReceiptTaxRow>();
  for (const line of sortedLines) {
    const vatRateBps = line.taxTreatment === "STANDARD" ? line.vatRateBps : 0;
    const key = `${line.taxTreatment}:${vatRateBps}:${line.cityTaxRateBps}`;
    const group = groups.get(key) ?? {
      treatment: line.taxTreatment,
      vatRateBps,
      cityTaxRateBps: line.cityTaxRateBps,
      base: 0n,
      vat: 0n,
      cityTax: 0n,
    };
    group.base += line.netAmount;
    group.vat += line.vatAmount;
    group.cityTax += line.cityTaxAmount;
    groups.set(key, group);
  }
  const taxRows = [...groups.values()].sort(
    (a, b) =>
      a.treatment.localeCompare(b.treatment) ||
      a.vatRateBps - b.vatRateBps ||
      a.cityTaxRateBps - b.cityTaxRateBps,
  );

  const tenders: ReceiptTender[] = source.payments.map((payment) => {
    const brand = clean(payment.cardBrand);
    const last4 = clean(payment.cardLast4);
    const card =
      brand && last4 ? `${brand} ****${last4}` : brand ? brand : last4 ? `****${last4}` : null;
    return {
      method: payment.method,
      amount: payment.amount,
      tendered: payment.tendered ?? null,
      change: payment.change,
      detail: card ?? clean(payment.reference),
    };
  });

  const timezone = clean(location.timezone) ?? DEFAULT_TIME_ZONE;
  const when = localDateTime(sale.occurredAt, timezone);

  const headerText = splitLines(location.header ?? business?.header);
  const footer = splitLines(business?.footer);

  return {
    header: {
      businessName: business?.name ?? "",
      legalName: clean(business?.legalName),
      locationName: location.name,
      address: clean(location.address) ?? clean(business?.address),
      phones: [
        ...new Set([clean(location.phone), clean(business?.phone)].filter(Boolean)),
      ] as string[],
      email: clean(business?.email),
      taxId: clean(business?.taxId),
      text: headerText,
    },
    number: sale.number,
    date: when.date,
    time: when.time,
    timeZone: when.timeZone,
    cashier: sale.cashierName,
    buyerTaxId: clean(sale.buyerTaxId),
    voided: sale.voided === true,
    note: clean(sale.note),
    lines,
    taxRows,
    totals: {
      items: sale.itemsAmount,
      discount: sale.discountAmount,
      net: sale.netAmount,
      vat: sale.vatAmount,
      cityTax: sale.cityTaxAmount,
      tip: sale.tipAmount,
      rounding: sale.roundingAmount,
      total: sale.totalAmount,
    },
    tenders,
    changeTotal: sum(tenders.map((t) => t.change)),
    fiscal: {
      status: source.fiscal?.status ?? "NONE",
      lotteryCode: clean(source.fiscal?.lotteryCode),
      qrData: clean(source.fiscal?.qrData),
    },
    footer,
  };
}
