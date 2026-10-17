import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { PaymentMethod } from "@/domain/refund";
import type { ReceiptKey } from "@/lib/refunds/receipt-input";
import { db } from "../db";
import { verifyCreditNoteToken } from "../services/credit-note-token";

/**
 * Sales as the register's Returns screen reads them. Everything is scoped to
 * the location of the paired device the request comes from (the action passes
 * it, derived server-side; it is never taken from the client), costs and staff
 * ids never leave this module, and every query is a bounded read.
 */

export interface ReturnScope {
  locationId: string;
  registerId: string;
}

// ---------------------------------------------------------------------------
// Refund policy
// ---------------------------------------------------------------------------

/**
 * Refunds older than this many whole days need a manager's approval:
 * `BusinessSettings.refundWindowDays` (null = no limit), the same value the
 * refund service enforces, so the screen asks for exactly the approvals the
 * server will require.
 */
export async function refundWindowDays(): Promise<number | null> {
  const settings = await db.businessSettings.findUnique({
    where: { id: 1 },
    select: { refundWindowDays: true },
  });
  const days = settings?.refundWindowDays ?? null;
  return days !== null && days > 0 ? days : null;
}

export async function roundingUnit(): Promise<bigint> {
  const settings = await db.businessSettings.findUnique({
    where: { id: 1 },
    select: { totalRoundingUnit: true },
  });
  return settings?.totalRoundingUnit ?? 100n;
}

// ---------------------------------------------------------------------------
// One sale, in full
// ---------------------------------------------------------------------------

const detailSelect = {
  id: true,
  number: true,
  occurredAt: true,
  locationId: true,
  registerId: true,
  shiftId: true,
  totalAmount: true,
  itemsAmount: true,
  tipAmount: true,
  roundingAmount: true,
  vatAmount: true,
  cashier: { select: { name: true } },
  void: { select: { reason: true, createdAt: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      id: true,
      lineNo: true,
      name: true,
      sku: true,
      variantId: true,
      unit: true,
      qtyMilli: true,
      unitPrice: true,
      totalAmount: true,
      netAmount: true,
      vatAmount: true,
      cityTaxAmount: true,
      pricesIncludeTax: true,
      productType: true,
      giftCard: { select: { id: true } },
      product: { select: { trackStock: true, type: true } },
    },
  },
  payments: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      method: true,
      amount: true,
      change: true,
      reference: true,
      cardLast4: true,
    },
  },
  refunds: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      occurredAt: true,
      reason: true,
      totalAmount: true,
      tipAmount: true,
      lines: {
        select: {
          saleLineId: true,
          qtyMilli: true,
          restock: true,
          netAmount: true,
          vatAmount: true,
          cityTaxAmount: true,
          totalAmount: true,
        },
      },
      payments: { select: { method: true, amount: true, originalPaymentId: true } },
    },
  },
} satisfies Prisma.SaleSelect;

type DetailRow = Prisma.SaleGetPayload<{ select: typeof detailSelect }>;

/** JSON-ready (ISO dates; the action turns bigint into decimal strings). */
export function toReturnSale(row: DetailRow, movedVariants: ReadonlySet<string>) {
  return {
    id: row.id,
    number: row.number,
    occurredAt: row.occurredAt.toISOString(),
    locationId: row.locationId,
    registerId: row.registerId,
    shiftId: row.shiftId,
    cashierName: row.cashier.name,
    totalAmount: row.totalAmount,
    itemsAmount: row.itemsAmount,
    tipAmount: row.tipAmount,
    roundingAmount: row.roundingAmount,
    vatAmount: row.vatAmount,
    status: row.void ? ("VOIDED" as const) : ("COMPLETED" as const),
    voided: row.void ? { reason: row.void.reason, at: row.void.createdAt.toISOString() } : null,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      name: line.name,
      sku: line.sku,
      variantId: line.variantId,
      unit: line.unit,
      qtyMilli: line.qtyMilli,
      unitPrice: line.unitPrice,
      totalAmount: line.totalAmount,
      netAmount: line.netAmount,
      vatAmount: line.vatAmount,
      cityTaxAmount: line.cityTaxAmount,
      pricesIncludeTax: line.pricesIncludeTax,
      // Same rule as the refund service: a line restocks only when the product is tracked
      // STANDARD now AND this sale really moved its stock. Anything else and the screen
      // would default "restock" on where the server turns it off, and the approval scope
      // (which binds the effective restock flags) would never match.
      tracksStock:
        line.product.trackStock &&
        line.product.type === "STANDARD" &&
        movedVariants.has(line.variantId),
      isGiftCard: line.productType === "GIFT_CARD" || line.giftCard !== null,
    })),
    payments: row.payments.map((p) => ({
      id: p.id,
      method: p.method as PaymentMethod,
      amount: p.amount,
      change: p.change,
      reference: p.reference,
      cardLast4: p.cardLast4,
    })),
    refunds: row.refunds.map((r) => ({
      id: r.id,
      number: r.number,
      occurredAt: r.occurredAt.toISOString(),
      reason: r.reason,
      totalAmount: r.totalAmount,
      tipAmount: r.tipAmount,
      lines: r.lines,
      payments: r.payments.map((p) => ({
        method: p.method as PaymentMethod,
        amount: p.amount,
        originalPaymentId: p.originalPaymentId,
      })),
    })),
  };
}

/** A UUID that is no sale: the filter for a link that did not verify. */
const NO_SALE = "00000000-0000-0000-0000-000000000000";

function keyFilter(key: ReceiptKey): Prisma.SaleWhereInput {
  switch (key.kind) {
    case "number":
      return { number: key.number };
    case "token":
      return { publicToken: key.token };
    case "id":
      return { id: key.id };
    case "refundId":
      return { refunds: { some: { id: key.id } } };
    case "credit": {
      // A signed credit-note / void-slip link: only a valid signature names a sale.
      const id = verifyCreditNoteToken(key.type, key.token);
      if (!id) return { id: NO_SALE };
      return key.type === "refund" ? { refunds: { some: { id } } } : { id };
    }
  }
}

/** The sale behind a typed/scanned receipt key, at this device's location, or null. */
export async function findReturnSale(scope: ReturnScope, key: ReceiptKey) {
  const row = await db.sale.findFirst({
    where: { AND: [keyFilter(key), { locationId: scope.locationId }] },
    select: detailSelect,
  });
  if (!row) return null;
  const moved = await db.stockMovement.findMany({
    where: { saleId: row.id, type: "SALE" },
    select: { variantId: true },
  });
  return toReturnSale(row, new Set(moved.map((m) => m.variantId)));
}

// ---------------------------------------------------------------------------
// Recent sales
// ---------------------------------------------------------------------------

export const RECENT_LIMIT = 30;

export type RecentState = "OK" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOIDED";

const recentSelect = {
  id: true,
  number: true,
  occurredAt: true,
  shiftId: true,
  totalAmount: true,
  void: { select: { id: true } },
  lines: { select: { id: true, qtyMilli: true, productType: true } },
  payments: { select: { method: true } },
  refunds: { select: { lines: { select: { saleLineId: true, qtyMilli: true } } } },
} satisfies Prisma.SaleSelect;

type RecentRow = Prisma.SaleGetPayload<{ select: typeof recentSelect }>;

export function recentState(row: RecentRow): RecentState {
  if (row.void) return "VOIDED";
  if (row.refunds.length === 0) return "OK";
  const refunded = new Map<string, number>();
  for (const refund of row.refunds) {
    for (const line of refund.lines) {
      refunded.set(line.saleLineId, (refunded.get(line.saleLineId) ?? 0) + line.qtyMilli);
    }
  }
  const refundable = row.lines.filter((l) => l.productType !== "GIFT_CARD");
  const anyLeft = refundable.some((l) => (refunded.get(l.id) ?? 0) < l.qtyMilli);
  return anyLeft ? "PARTIALLY_REFUNDED" : "REFUNDED";
}

export interface RecentSalesFilter {
  /** Only this shift (the open one), or every shift of the register. */
  shiftId: string | null;
  /** Part of a receipt number. */
  query: string;
}

/** Newest first. `truncated` says more matched than the page holds. */
export async function listRecentSales(scope: ReturnScope, filter: RecentSalesFilter) {
  const query = filter.query.trim();
  const rows = await db.sale.findMany({
    where: {
      locationId: scope.locationId,
      registerId: scope.registerId,
      ...(filter.shiftId ? { shiftId: filter.shiftId } : {}),
      ...(query ? { number: { contains: query, mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: RECENT_LIMIT + 1,
    select: recentSelect,
  });
  return {
    sales: rows.slice(0, RECENT_LIMIT).map((row) => ({
      id: row.id,
      number: row.number,
      occurredAt: row.occurredAt.toISOString(),
      shiftId: row.shiftId,
      totalAmount: row.totalAmount,
      lineCount: row.lines.length,
      methods: [...new Set(row.payments.map((p) => p.method as PaymentMethod))],
      state: recentState(row),
    })),
    truncated: rows.length > RECENT_LIMIT,
  };
}
