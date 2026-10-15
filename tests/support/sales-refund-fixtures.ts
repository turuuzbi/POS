import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import type { ReceiptContext } from "./receipt-fixtures";

/**
 * Refund fixtures: direct inserts (the refund service is built elsewhere).
 * Refunds are append-only, so each call adds a complete refund; nothing is
 * ever updated afterwards.
 */

export interface FixtureRefundLine {
  /** Line number of the ORIGINAL sale line. */
  lineNo: number;
  qtyMilli: number;
  /** Amount refunded for the line, incl. tax. */
  total: bigint;
  vat: bigint;
  restock?: boolean;
}

export interface FixtureRefundPayment {
  method: "CASH" | "CARD" | "QPAY" | "BANK_TRANSFER" | "EXCHANGE_CREDIT";
  amount: bigint;
}

export interface RefundFixtureOptions {
  lines?: FixtureRefundLine[];
  payments?: FixtureRefundPayment[];
  reason?: "DEFECTIVE" | "DAMAGED" | "WRONG_ITEM" | "NOT_AS_DESCRIBED" | "CHANGED_MIND" | "OTHER";
  note?: string;
  roundingAmount?: bigint;
  tipAmount?: bigint;
  number?: string;
  occurredAt?: Date;
  approvedById?: string;
  exchangeSaleId?: string;
  /** Overrides the computed refund total (e.g. to complete a sale exactly). */
  totalAmount?: bigint;
}

/**
 * Inserts a complete refund against a fixture sale: refund + lines + payouts.
 * The default refunds line 1 of the sale entirely, paid back in cash.
 */
export async function createReceiptRefund(
  sale: { id: string; context: ReceiptContext },
  options: RefundFixtureOptions = {},
) {
  const saleLines = await db.saleLine.findMany({
    where: { saleId: sale.id },
    orderBy: { lineNo: "asc" },
  });
  const first = saleLines[0]!;
  const wanted = options.lines ?? [
    { lineNo: 1, qtyMilli: first.qtyMilli, total: first.totalAmount, vat: first.vatAmount },
  ];
  const items = wanted.reduce((s, l) => s + l.total, 0n);
  const vat = wanted.reduce((s, l) => s + l.vat, 0n);
  const rounding = options.roundingAmount ?? 0n;
  const tip = options.tipAmount ?? 0n;
  const total = options.totalAmount ?? items + tip + rounding;
  const payments = options.payments ?? [{ method: "CASH" as const, amount: total }];
  const id = randomUUID();

  await db.refund.create({
    data: {
      id,
      number: options.number ?? `R-${id.slice(0, 8)}`,
      saleId: sale.id,
      locationId: sale.context.locationId,
      registerId: sale.context.registerId,
      shiftId: sale.context.shiftId,
      processedById: sale.context.cashierId,
      approvedById: options.approvedById ?? null,
      reason: options.reason ?? "DEFECTIVE",
      note: options.note ?? null,
      netAmount: items - vat,
      vatAmount: vat,
      tipAmount: tip,
      roundingAmount: rounding,
      totalAmount: total,
      exchangeSaleId: options.exchangeSaleId ?? null,
      occurredAt: options.occurredAt ?? new Date("2026-10-14T18:30:00Z"),
      lines: {
        create: wanted.map((line) => {
          const original = saleLines.find((l) => l.lineNo === line.lineNo)!;
          return {
            saleLineId: original.id,
            qtyMilli: line.qtyMilli,
            restock: line.restock ?? true,
            netAmount: line.total - line.vat,
            vatAmount: line.vat,
            totalAmount: line.total,
            unitCost: original.unitCost,
          };
        }),
      },
      payments: {
        create: payments.map((p) => ({ method: p.method, amount: p.amount })),
      },
    },
  });
  return { id, total };
}
