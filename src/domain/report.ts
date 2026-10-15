/**
 * X- and Z-report builders (Phase 3, pure). They aggregate plain rows that the
 * service already filtered to one shift: the sales rung up in it, the refunds
 * processed in it (against any sale), and its cash movements.
 *
 * Rules:
 *  - a voided sale is LISTED (voids) but excluded from sales, tax, items and
 *    tenders;
 *  - refunds are counted exactly once, from their own rows; sale rows never
 *    carry refund amounts;
 *  - tenders by method = sale payments − refund payments (EXCHANGE_CREDIT nets
 *    to zero: the refund creates it, the exchange sale spends it);
 *  - net takings = sales total − refunds total = Σ tenders (checked by
 *    `checkReportInvariants`);
 *  - expected cash comes from shift.ts, so the till and the report agree.
 *
 * A Z-report is an X-report plus the closing count, frozen with
 * `reportToJson` into `ZReport.data`.
 */
import { sum, type Money } from "./money";
import { PAYMENT_METHODS, type PaymentMethod } from "./refund";
import type { Unit } from "./qty";
import {
  cashVariance,
  classifyVariance,
  expectedCash,
  sumCashMovements,
  type CashMovementKind,
  type VarianceClass,
} from "./shift";
import type { TaxTreatment } from "./tax";
import type { VoidReason } from "./void";

export interface ReportLineRow {
  qtyMilli: number;
  unit: Unit;
  taxTreatment: TaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  netAmount: Money;
  vatAmount: Money;
  cityTaxAmount: Money;
  totalAmount: Money;
}

export interface ReportSaleRow {
  id: string;
  /** Receipt number, e.g. "UB1-000123". */
  number: string;
  occurredAt: Date;
  /** Set when a SaleVoid exists. */
  void: { reason: VoidReason; note?: string | undefined } | null;
  /** Σ line totals (after discounts, tax included). */
  itemsAmount: Money;
  /** Σ line + cart discounts (informational). */
  discountAmount: Money;
  tipAmount: Money;
  roundingAmount: Money;
  totalAmount: Money;
  lines: ReportLineRow[];
  /** `amount` excludes change; `change` is informational. */
  payments: { method: PaymentMethod; amount: Money; change?: Money }[];
  discounts?: { source: string; amount: Money }[];
}

export interface ReportRefundRow {
  id: string;
  number: string;
  saleId: string;
  occurredAt: Date;
  tipAmount: Money;
  roundingAmount: Money;
  totalAmount: Money;
  lines: ReportLineRow[];
  payments: { method: PaymentMethod; amount: Money }[];
}

export interface ShiftReportInput {
  shift: { id: string; registerId: string; openedAt: Date; openingFloat: Money };
  sales: readonly ReportSaleRow[];
  refunds: readonly ReportRefundRow[];
  cashMovements: readonly { type: CashMovementKind; amount: Money }[];
  /** When the report was run (the caller's clock). */
  asOf: Date;
}

export interface TaxRateRow {
  taxTreatment: TaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  salesNet: Money;
  salesVat: Money;
  salesCity: Money;
  salesGross: Money;
  refundNet: Money;
  refundVat: Money;
  refundCity: Money;
  refundGross: Money;
  net: Money;
  vat: Money;
  city: Money;
  gross: Money;
}

export interface TenderRow {
  method: PaymentMethod;
  sales: Money;
  refunds: Money;
  net: Money;
}

export interface ShiftReport {
  kind: "X" | "Z";
  shiftId: string;
  registerId: string;
  openedAt: Date;
  asOf: Date;

  saleCount: number;
  voidCount: number;
  refundCount: number;
  firstReceiptNumber: string | null;
  lastReceiptNumber: string | null;

  /** Before discounts: itemsSales + discounts (informational; mixes tax modes if the cart does). */
  grossSales: Money;
  discounts: Money;
  discountsBySource: { source: string; amount: Money }[];
  /** Σ itemsAmount of non-voided sales. */
  itemsSales: Money;
  tips: Money;
  rounding: Money;
  /** Σ totalAmount of non-voided sales. */
  salesTotal: Money;
  refunds: { itemsTotal: Money; tips: Money; rounding: Money; total: Money };
  /** salesTotal − refunds.total: net takings. */
  netSales: Money;

  /** Tax net of refunds (items only; tips and rounding carry no tax). */
  tax: { net: Money; vat: Money; city: Money };
  taxByRate: TaxRateRow[];

  tenders: TenderRow[];
  tendersTotal: Money;

  cash: {
    openingFloat: Money;
    cashSales: Money;
    cashRefunds: Money;
    cashIn: Money;
    cashOut: Money;
    changeGiven: Money;
    expected: Money;
  };

  items: {
    lineCount: number;
    pieceCount: number;
    measuredLineCount: number;
    refundedPieceCount: number;
    refundedMeasuredLineCount: number;
  };

  voids: {
    saleId: string;
    number: string;
    reason: VoidReason;
    note?: string;
    totalAmount: Money;
  }[];
  voidedTotal: Money;

  /** Z only. */
  closing?: {
    closedAt: Date;
    countedCash: Money;
    cashVariance: Money;
    classification: VarianceClass;
    denominations: Record<string, number>;
    note?: string;
  };
}

function assertUnique(ids: readonly string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new RangeError(`report: duplicate ${what} row`);
}

const rateKey = (l: ReportLineRow) => `${l.taxTreatment}|${l.vatRateBps}|${l.cityTaxRateBps}`;

function emptyRate(l: ReportLineRow): TaxRateRow {
  return {
    taxTreatment: l.taxTreatment,
    vatRateBps: l.vatRateBps,
    cityTaxRateBps: l.cityTaxRateBps,
    salesNet: 0n,
    salesVat: 0n,
    salesCity: 0n,
    salesGross: 0n,
    refundNet: 0n,
    refundVat: 0n,
    refundCity: 0n,
    refundGross: 0n,
    net: 0n,
    vat: 0n,
    city: 0n,
    gross: 0n,
  };
}

const pieces = (lines: readonly ReportLineRow[]) =>
  lines.reduce((n, l) => n + (l.unit === "PIECE" ? Math.trunc(l.qtyMilli / 1000) : 0), 0);
const measured = (lines: readonly ReportLineRow[]) =>
  lines.filter((l) => l.unit !== "PIECE").length;

export function buildXReport(input: ShiftReportInput): ShiftReport {
  assertUnique(
    input.sales.map((s) => s.id),
    "sale",
  );
  assertUnique(
    input.refunds.map((r) => r.id),
    "refund",
  );

  const active = input.sales.filter((s) => s.void === null);
  const voided = input.sales.filter((s) => s.void !== null);

  // ---- sales ---------------------------------------------------------------
  const itemsSales = sum(active.map((s) => s.itemsAmount));
  const discounts = sum(active.map((s) => s.discountAmount));
  const tips = sum(active.map((s) => s.tipAmount));
  const rounding = sum(active.map((s) => s.roundingAmount));
  const salesTotal = sum(active.map((s) => s.totalAmount));

  const bySource = new Map<string, Money>();
  for (const sale of active) {
    for (const d of sale.discounts ?? []) {
      bySource.set(d.source, (bySource.get(d.source) ?? 0n) + d.amount);
    }
  }
  const discountsBySource = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, amount]) => ({ source, amount }));

  const ordered = [...active].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0),
  );

  // ---- refunds -------------------------------------------------------------
  const refundsTotal = sum(input.refunds.map((r) => r.totalAmount));
  const refundTips = sum(input.refunds.map((r) => r.tipAmount));
  const refundRounding = sum(input.refunds.map((r) => r.roundingAmount));
  const refundItems = refundsTotal - refundTips - refundRounding;

  // ---- tax -------------------------------------------------------------------
  const rates = new Map<string, TaxRateRow>();
  const rateRow = (l: ReportLineRow) => {
    const key = rateKey(l);
    let row = rates.get(key);
    if (!row) rates.set(key, (row = emptyRate(l)));
    return row;
  };
  for (const sale of active) {
    for (const l of sale.lines) {
      const row = rateRow(l);
      row.salesNet += l.netAmount;
      row.salesVat += l.vatAmount;
      row.salesCity += l.cityTaxAmount;
      row.salesGross += l.totalAmount;
    }
  }
  for (const refund of input.refunds) {
    for (const l of refund.lines) {
      const row = rateRow(l);
      row.refundNet += l.netAmount;
      row.refundVat += l.vatAmount;
      row.refundCity += l.cityTaxAmount;
      row.refundGross += l.totalAmount;
    }
  }
  const taxByRate = [...rates.values()]
    .map((row) => ({
      ...row,
      net: row.salesNet - row.refundNet,
      vat: row.salesVat - row.refundVat,
      city: row.salesCity - row.refundCity,
      gross: row.salesGross - row.refundGross,
    }))
    .sort(
      (a, b) =>
        b.vatRateBps - a.vatRateBps ||
        b.cityTaxRateBps - a.cityTaxRateBps ||
        (a.taxTreatment < b.taxTreatment ? -1 : a.taxTreatment > b.taxTreatment ? 1 : 0),
    );

  // ---- tenders -------------------------------------------------------------
  const tenderMap = new Map<PaymentMethod, { sales: Money; refunds: Money }>();
  const tender = (m: PaymentMethod) => {
    let row = tenderMap.get(m);
    if (!row) tenderMap.set(m, (row = { sales: 0n, refunds: 0n }));
    return row;
  };
  let changeGiven = 0n;
  for (const sale of active) {
    for (const p of sale.payments) {
      tender(p.method).sales += p.amount;
      if (p.method === "CASH") changeGiven += p.change ?? 0n;
    }
  }
  for (const refund of input.refunds) {
    for (const p of refund.payments) tender(p.method).refunds += p.amount;
  }
  const tenders: TenderRow[] = PAYMENT_METHODS.filter((m) => tenderMap.has(m)).map((method) => {
    const row = tenderMap.get(method)!;
    return { method, sales: row.sales, refunds: row.refunds, net: row.sales - row.refunds };
  });

  // ---- cash ----------------------------------------------------------------
  const cashRow = tenderMap.get("CASH") ?? { sales: 0n, refunds: 0n };
  const { cashIn, cashOut } = sumCashMovements(input.cashMovements);
  const expected = expectedCash({
    openingFloat: input.shift.openingFloat,
    cashSales: cashRow.sales,
    cashRefunds: cashRow.refunds,
    cashIn,
    cashOut,
  });

  const saleLines = active.flatMap((s) => s.lines);
  const refundLines = input.refunds.flatMap((r) => r.lines);

  return {
    kind: "X",
    shiftId: input.shift.id,
    registerId: input.shift.registerId,
    openedAt: input.shift.openedAt,
    asOf: input.asOf,
    saleCount: active.length,
    voidCount: voided.length,
    refundCount: input.refunds.length,
    firstReceiptNumber: ordered[0]?.number ?? null,
    lastReceiptNumber: ordered[ordered.length - 1]?.number ?? null,
    grossSales: itemsSales + discounts,
    discounts,
    discountsBySource,
    itemsSales,
    tips,
    rounding,
    salesTotal,
    refunds: {
      itemsTotal: refundItems,
      tips: refundTips,
      rounding: refundRounding,
      total: refundsTotal,
    },
    netSales: salesTotal - refundsTotal,
    tax: {
      net: sum(taxByRate.map((r) => r.net)),
      vat: sum(taxByRate.map((r) => r.vat)),
      city: sum(taxByRate.map((r) => r.city)),
    },
    taxByRate,
    tenders,
    tendersTotal: sum(tenders.map((t) => t.net)),
    cash: {
      openingFloat: input.shift.openingFloat,
      cashSales: cashRow.sales,
      cashRefunds: cashRow.refunds,
      cashIn,
      cashOut,
      changeGiven,
      expected,
    },
    items: {
      lineCount: saleLines.length,
      pieceCount: pieces(saleLines),
      measuredLineCount: measured(saleLines),
      refundedPieceCount: pieces(refundLines),
      refundedMeasuredLineCount: measured(refundLines),
    },
    voids: voided
      .map((s) => ({
        saleId: s.id,
        number: s.number,
        reason: s.void!.reason,
        ...(s.void!.note ? { note: s.void!.note } : {}),
        totalAmount: s.totalAmount,
      }))
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0)),
    voidedTotal: sum(voided.map((s) => s.totalAmount)),
  };
}

export interface ZClosing {
  closedAt: Date;
  countedCash: Money;
  denominations: Record<string, number>;
  note?: string | undefined;
}

/** The X-report plus the closing count and variance, ready to freeze. */
export function buildZReport(input: ShiftReportInput, closing: ZClosing): ShiftReport {
  const report = buildXReport(input);
  const variance = cashVariance(closing.countedCash, report.cash.expected);
  return {
    ...report,
    kind: "Z",
    closing: {
      closedAt: closing.closedAt,
      countedCash: closing.countedCash,
      cashVariance: variance,
      classification: classifyVariance(variance),
      denominations: { ...closing.denominations },
      ...(closing.note ? { note: closing.note } : {}),
    },
  };
}

/** Accounting identities a correct report satisfies; each failure is a string. */
export function checkReportInvariants(
  input: ShiftReportInput,
  report: ShiftReport = buildXReport(input),
): string[] {
  const problems: string[] = [];
  const voidedIds = new Set(input.sales.filter((s) => s.void !== null).map((s) => s.id));
  for (const s of input.sales) {
    if (s.void !== null) continue;
    if (sum(s.payments.map((p) => p.amount)) !== s.totalAmount) {
      problems.push(`sale ${s.number}: payments do not add up to the total`);
    }
    if (sum(s.lines.map((l) => l.totalAmount)) !== s.itemsAmount) {
      problems.push(`sale ${s.number}: lines do not add up to the items amount`);
    }
    if (s.itemsAmount + s.tipAmount + s.roundingAmount !== s.totalAmount) {
      problems.push(`sale ${s.number}: items + tip + rounding != total`);
    }
  }
  for (const r of input.refunds) {
    if (voidedIds.has(r.saleId)) problems.push(`refund ${r.number}: against a voided sale`);
    if (sum(r.payments.map((p) => p.amount)) !== r.totalAmount) {
      problems.push(`refund ${r.number}: payments do not add up to the total`);
    }
    if (sum(r.lines.map((l) => l.totalAmount)) + r.tipAmount + r.roundingAmount !== r.totalAmount) {
      problems.push(`refund ${r.number}: lines + tip + rounding != total`);
    }
  }
  if (report.tendersTotal !== report.netSales) {
    problems.push("tenders do not add up to net takings");
  }
  const taxGross = sum(report.taxByRate.map((r) => r.gross));
  if (
    taxGross + report.tips + report.rounding - report.refunds.tips - report.refunds.rounding !==
    report.netSales
  ) {
    problems.push("tax rows + tips + rounding do not add up to net takings");
  }
  if (report.tax.net + report.tax.vat + report.tax.city !== taxGross) {
    problems.push("tax parts do not add up to the gross");
  }
  return problems;
}

/** JSON-safe copy for `ZReport.data`: bigint → decimal string, Date → ISO string. */
export function reportToJson(report: ShiftReport): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  return walk(report);
}
