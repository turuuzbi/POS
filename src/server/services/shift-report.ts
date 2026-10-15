import "server-only";
import type { Money } from "@/domain/money";
import {
  type ReportLineRow,
  type ReportRefundRow,
  type ReportSaleRow,
  type ShiftReportInput,
} from "@/domain/report";
import type { Unit } from "@/domain/qty";
import { expectedCash } from "@/domain/shift";
import type { Db } from "../db";

/**
 * Plain rows of one shift for the pure report builders: the sales rung up in
 * it (voided ones flagged), the refunds PROCESSED in it (against any sale) and
 * its cash movements. Used by the X report, the Z report at close and the
 * admin views, so all of them agree.
 */
export async function loadShiftReportInput(
  client: Db,
  shiftId: string,
  asOf: Date,
): Promise<ShiftReportInput> {
  const shift = await client.shift.findUniqueOrThrow({
    where: { id: shiftId },
    select: { id: true, registerId: true, openedAt: true, openingFloat: true },
  });
  const [sales, refunds, movements] = await Promise.all([
    client.sale.findMany({
      where: { shiftId },
      orderBy: [{ occurredAt: "asc" }, { number: "asc" }],
      include: {
        lines: true,
        payments: { orderBy: { createdAt: "asc" } },
        discounts: { select: { source: true, amount: true } },
        void: { select: { reason: true, note: true } },
      },
    }),
    client.refund.findMany({
      where: { shiftId },
      orderBy: [{ occurredAt: "asc" }, { number: "asc" }],
      include: {
        lines: { include: { saleLine: true } },
        payments: { orderBy: { createdAt: "asc" } },
      },
    }),
    client.cashMovement.findMany({
      where: { shiftId },
      select: { type: true, amount: true },
    }),
  ]);

  const saleRows: ReportSaleRow[] = sales.map((s) => ({
    id: s.id,
    number: s.number,
    occurredAt: s.occurredAt,
    void: s.void ? { reason: s.void.reason, ...(s.void.note ? { note: s.void.note } : {}) } : null,
    itemsAmount: s.itemsAmount,
    discountAmount: s.discountAmount,
    tipAmount: s.tipAmount,
    roundingAmount: s.roundingAmount,
    totalAmount: s.totalAmount,
    lines: s.lines.map((l): ReportLineRow => ({
      qtyMilli: l.qtyMilli,
      unit: l.unit as Unit,
      taxTreatment: l.taxTreatment,
      vatRateBps: l.vatRateBps,
      cityTaxRateBps: l.cityTaxRateBps,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      totalAmount: l.totalAmount,
    })),
    payments: s.payments.map((p) => ({ method: p.method, amount: p.amount, change: p.change })),
    discounts: s.discounts.map((d) => ({ source: d.source, amount: d.amount })),
  }));

  const refundRows: ReportRefundRow[] = refunds.map((r) => ({
    id: r.id,
    number: r.number,
    saleId: r.saleId,
    occurredAt: r.occurredAt,
    tipAmount: r.tipAmount,
    roundingAmount: r.roundingAmount,
    totalAmount: r.totalAmount,
    lines: r.lines.map((l): ReportLineRow => ({
      qtyMilli: l.qtyMilli,
      unit: l.saleLine.unit as Unit,
      taxTreatment: l.saleLine.taxTreatment,
      vatRateBps: l.saleLine.vatRateBps,
      cityTaxRateBps: l.saleLine.cityTaxRateBps,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      totalAmount: l.totalAmount,
    })),
    payments: r.payments.map((p) => ({ method: p.method, amount: p.amount })),
  }));

  return {
    shift,
    sales: saleRows,
    refunds: refundRows,
    cashMovements: movements,
    asOf,
  };
}

/**
 * Expected drawer cash of a shift from the database. `until` limits every row
 * to what was recorded at or before that instant (replaying a cash movement
 * must report the drawer as it was right after it).
 */
export async function loadExpectedCash(
  client: Db,
  shiftId: string,
  until?: Date,
): Promise<{
  openingFloat: Money;
  cashSales: Money;
  cashRefunds: Money;
  cashIn: Money;
  cashOut: Money;
  expected: Money;
}> {
  const at = until ? { lte: until } : undefined;
  const shift = await client.shift.findUniqueOrThrow({
    where: { id: shiftId },
    select: { openingFloat: true },
  });
  const [sales, refunds, movements] = await Promise.all([
    client.salePayment.aggregate({
      _sum: { amount: true },
      where: {
        method: "CASH",
        sale: { shiftId, void: null },
        ...(at ? { createdAt: at } : {}),
      },
    }),
    client.refundPayment.aggregate({
      _sum: { amount: true },
      where: { method: "CASH", refund: { shiftId }, ...(at ? { createdAt: at } : {}) },
    }),
    client.cashMovement.groupBy({
      by: ["type"],
      _sum: { amount: true },
      where: { shiftId, ...(at ? { createdAt: at } : {}) },
    }),
  ]);
  const cashSales = sales._sum.amount ?? 0n;
  const cashRefunds = refunds._sum.amount ?? 0n;
  const cashIn = movements.find((m) => m.type === "CASH_IN")?._sum.amount ?? 0n;
  const cashOut = movements.find((m) => m.type === "CASH_OUT")?._sum.amount ?? 0n;
  const parts = { openingFloat: shift.openingFloat, cashSales, cashRefunds, cashIn, cashOut };
  return { ...parts, expected: expectedCash(parts) };
}
