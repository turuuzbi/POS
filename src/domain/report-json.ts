/**
 * Reading a frozen report back (pure). `reportToJson` turns bigint money into
 * decimal strings and dates into ISO strings; this is the inverse, validated
 * with zod, so a Z-report stored in `ZReport.data` (or sent to the browser)
 * becomes a typed `ShiftReport` again.
 */
import { z } from "zod";
import { VOID_REASONS } from "./void";
import { PAYMENT_METHODS } from "./refund";
import type { ShiftReport } from "./report";

const money = z
  .string()
  .regex(/^-?\d+$/)
  .transform((v) => BigInt(v));
const date = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const int = z.number().int();

const taxRate = z.object({
  taxTreatment: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT"]),
  vatRateBps: int,
  cityTaxRateBps: int,
  salesNet: money,
  salesVat: money,
  salesCity: money,
  salesGross: money,
  refundNet: money,
  refundVat: money,
  refundCity: money,
  refundGross: money,
  net: money,
  vat: money,
  city: money,
  gross: money,
});

export const shiftReportJsonSchema = z.object({
  kind: z.enum(["X", "Z"]),
  shiftId: z.string(),
  registerId: z.string(),
  openedAt: date,
  asOf: date,
  saleCount: int,
  voidCount: int,
  refundCount: int,
  firstReceiptNumber: z.string().nullable(),
  lastReceiptNumber: z.string().nullable(),
  grossSales: money,
  discounts: money,
  discountsBySource: z.array(z.object({ source: z.string(), amount: money })),
  itemsSales: money,
  tips: money,
  rounding: money,
  salesTotal: money,
  refunds: z.object({ itemsTotal: money, tips: money, rounding: money, total: money }),
  netSales: money,
  tax: z.object({ net: money, vat: money, city: money }),
  taxByRate: z.array(taxRate),
  tenders: z.array(
    z.object({ method: z.enum(PAYMENT_METHODS), sales: money, refunds: money, net: money }),
  ),
  tendersTotal: money,
  cash: z.object({
    openingFloat: money,
    cashSales: money,
    cashRefunds: money,
    cashIn: money,
    cashOut: money,
    changeGiven: money,
    expected: money,
  }),
  items: z.object({
    lineCount: int,
    pieceCount: int,
    measuredLineCount: int,
    refundedPieceCount: int,
    refundedMeasuredLineCount: int,
  }),
  voids: z.array(
    z.object({
      saleId: z.string(),
      number: z.string(),
      reason: z.enum(VOID_REASONS),
      note: z.string().optional(),
      totalAmount: money,
    }),
  ),
  voidedTotal: money,
  closing: z
    .object({
      closedAt: date,
      countedCash: money,
      cashVariance: money,
      classification: z.enum(["OK", "SHORT", "OVER"]),
      denominations: z.record(z.string(), int),
      note: z.string().optional(),
    })
    .optional(),
});

/** Parse JSON produced by `reportToJson`; null when it is not a valid report. */
export function parseReportJson(json: unknown): ShiftReport | null {
  const parsed = shiftReportJsonSchema.safeParse(json);
  // The schema is the type's shape; optional keys differ only in `undefined` handling.
  return parsed.success ? (parsed.data as unknown as ShiftReport) : null;
}
