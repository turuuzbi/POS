import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { Money } from "@/domain/money";
import { groupTaxRows, type ReceiptPaymentMethod, type ReceiptTaxRow } from "@/domain/receipt";
import { deriveSaleStatus, type SaleStatus } from "@/domain/sale-status";
import { escapeLike, SALES_PAGE_SIZE, type SalesFilter } from "@/domain/sales-filter";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { userLocationFilter } from "./locations";

/**
 * Sales history (read model). The status of a sale is derived, never stored:
 * the list computes it in SQL with exactly the rules of `deriveSaleStatus`
 * (domain/sale-status.ts), which the detail page calls directly. Every query
 * here is location-scoped: a sale outside the user's locations never appears
 * in a list, a total, an export or a detail page.
 */

type Scope = Pick<CurrentUser, "locationIds">;

export interface SaleListRow {
  id: string;
  number: string;
  occurredAt: Date;
  totalAmount: Money;
  locationName: string;
  registerCode: string;
  cashierName: string;
  methods: ReceiptPaymentMethod[];
  refundedAmount: Money;
  refundCount: number;
  status: SaleStatus;
}

export interface SalesTotals {
  count: number;
  /** Σ totals of sales that are not voided. */
  gross: Money;
  /** Σ totals of voided sales. */
  voided: Money;
  /** Σ refunds against sales that are not voided. */
  refunded: Money;
  /** gross − refunded. */
  net: Money;
}

const FROM = Prisma.sql`
  FROM "Sale" s
  JOIN "Location" l ON l.id = s."locationId"
  JOIN "Register" rg ON rg.id = s."registerId"
  JOIN "User" u ON u.id = s."cashierId"
  LEFT JOIN "SaleVoid" v ON v."saleId" = s.id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r."totalAmount"), 0)::bigint AS total, COUNT(*)::int AS cnt
    FROM "Refund" r WHERE r."saleId" = s.id
  ) rf ON TRUE`;

// UTC instants go in as ISO text: `timestamp` columns hold UTC and the cast
// ignores the trailing Z, so no driver time-zone conversion can creep in.
const instant = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

function whereOf(scope: Scope, filter: SalesFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.locationIds !== "ALL") {
    parts.push(Prisma.sql`s."locationId" = ANY(${[...scope.locationIds]}::uuid[])`);
  }
  if (filter.locationId) parts.push(Prisma.sql`s."locationId" = ${filter.locationId}::uuid`);
  if (filter.registerId) parts.push(Prisma.sql`s."registerId" = ${filter.registerId}::uuid`);
  if (filter.cashierId) parts.push(Prisma.sql`s."cashierId" = ${filter.cashierId}::uuid`);
  if (filter.from) parts.push(Prisma.sql`s."occurredAt" >= ${instant(filter.from)}`);
  if (filter.to) parts.push(Prisma.sql`s."occurredAt" < ${instant(filter.to)}`);
  if (filter.minAmount !== null) {
    parts.push(Prisma.sql`s."totalAmount" >= ${filter.minAmount}::bigint`);
  }
  if (filter.maxAmount !== null) {
    parts.push(Prisma.sql`s."totalAmount" <= ${filter.maxAmount}::bigint`);
  }
  if (filter.q) {
    parts.push(Prisma.sql`s.number ILIKE ${"%" + escapeLike(filter.q) + "%"} ESCAPE '\\'`);
  }
  if (filter.method) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "SalePayment" p WHERE p."saleId" = s.id AND p.method = ${filter.method}::"PaymentMethod")`,
    );
  }
  switch (filter.status) {
    case "VOIDED":
      parts.push(Prisma.sql`v."saleId" IS NOT NULL`);
      break;
    case "COMPLETED":
      parts.push(Prisma.sql`v."saleId" IS NULL AND rf.cnt = 0`);
      break;
    case "REFUNDED":
      parts.push(Prisma.sql`v."saleId" IS NULL AND rf.cnt > 0 AND rf.total >= s."totalAmount"`);
      break;
    case "PARTIALLY_REFUNDED":
      parts.push(Prisma.sql`v."saleId" IS NULL AND rf.cnt > 0 AND rf.total < s."totalAmount"`);
      break;
    default:
      break;
  }
  return parts.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}

interface RawRow {
  id: string;
  number: string;
  occurredAt: Date;
  totalAmount: bigint;
  locationName: string;
  registerCode: string;
  cashierName: string;
  methods: string[] | null;
  voided: boolean;
  refunded: bigint;
  refundCount: number;
}

const SELECT_ROW = Prisma.sql`
  SELECT s.id, s.number, s."occurredAt", s."totalAmount",
         l.name AS "locationName", rg.code AS "registerCode", u.name AS "cashierName",
         ARRAY(SELECT DISTINCT p.method::text FROM "SalePayment" p WHERE p."saleId" = s.id ORDER BY 1) AS methods,
         (v."saleId" IS NOT NULL) AS voided, rf.total AS refunded, rf.cnt AS "refundCount"`;

function toRow(raw: RawRow): SaleListRow {
  return {
    id: raw.id,
    number: raw.number,
    occurredAt: raw.occurredAt,
    totalAmount: raw.totalAmount,
    locationName: raw.locationName,
    registerCode: raw.registerCode,
    cashierName: raw.cashierName,
    methods: (raw.methods ?? []) as ReceiptPaymentMethod[],
    refundedAmount: raw.refunded,
    refundCount: raw.refundCount,
    status: deriveSaleStatus({
      voided: raw.voided,
      saleTotal: raw.totalAmount,
      // One synthetic entry is enough: only the sum and the count matter.
      refundTotals: raw.refundCount > 0 ? [raw.refunded] : [],
    }),
  };
}

export async function listSales(
  scope: Scope,
  filter: SalesFilter,
): Promise<{
  rows: SaleListRow[];
  total: number;
  page: number;
  pages: number;
  totals: SalesTotals;
}> {
  const where = whereOf(scope, filter);
  const [totalsRows] = await db.$queryRaw<
    { count: number; gross: bigint; voided: bigint; refunded: bigint }[]
  >`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(CASE WHEN v."saleId" IS NULL THEN s."totalAmount" ELSE 0 END), 0)::bigint AS gross,
           COALESCE(SUM(CASE WHEN v."saleId" IS NOT NULL THEN s."totalAmount" ELSE 0 END), 0)::bigint AS voided,
           COALESCE(SUM(CASE WHEN v."saleId" IS NULL THEN rf.total ELSE 0 END), 0)::bigint AS refunded
    ${FROM} ${where}`;
  const count = totalsRows?.count ?? 0;
  const gross = totalsRows?.gross ?? 0n;
  const refunded = totalsRows?.refunded ?? 0n;
  const pages = Math.max(1, Math.ceil(count / SALES_PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const raw = await db.$queryRaw<RawRow[]>`
    ${SELECT_ROW} ${FROM} ${where}
    ORDER BY s."occurredAt" DESC, s.id DESC
    LIMIT ${SALES_PAGE_SIZE} OFFSET ${(page - 1) * SALES_PAGE_SIZE}`;
  return {
    rows: raw.map(toRow),
    total: count,
    page,
    pages,
    totals: { count, gross, voided: totalsRows?.voided ?? 0n, refunded, net: gross - refunded },
  };
}

/** Every matching sale, newest first, in keyset-paged batches (for the CSV export). */
export async function* iterateSales(
  scope: Scope,
  filter: SalesFilter,
  batch = 500,
): AsyncGenerator<SaleListRow[]> {
  const base = whereOf(scope, filter);
  let cursor: { at: Date; id: string } | null = null;
  for (;;) {
    const after: Prisma.Sql = cursor
      ? Prisma.sql`(s."occurredAt", s.id) < (${instant(cursor.at)}, ${cursor.id}::uuid)`
      : Prisma.empty;
    const where: Prisma.Sql =
      cursor === null
        ? base
        : base === Prisma.empty
          ? Prisma.sql`WHERE ${after}`
          : Prisma.sql`${base} AND ${after}`;
    const raw: RawRow[] = await db.$queryRaw<RawRow[]>`
      ${SELECT_ROW} ${FROM} ${where}
      ORDER BY s."occurredAt" DESC, s.id DESC
      LIMIT ${batch}`;
    if (raw.length === 0) return;
    yield raw.map(toRow);
    if (raw.length < batch) return;
    const last: RawRow = raw[raw.length - 1]!;
    cursor = { at: last.occurredAt, id: last.id };
  }
}

export interface SalesFilterOptions {
  locations: { id: string; name: string }[];
  registers: { id: string; code: string; locationId: string }[];
  cashiers: { id: string; name: string }[];
}

/** Choices for the filter form, limited to what the user may see. */
export async function getSalesFilterOptions(scope: Scope): Promise<SalesFilterOptions> {
  const locationWhere = userLocationFilter(scope);
  const [locations, registers, cashiers] = await Promise.all([
    db.location.findMany({
      where: locationWhere,
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.register.findMany({
      where: scope.locationIds === "ALL" ? {} : { locationId: { in: [...scope.locationIds] } },
      orderBy: [{ locationId: "asc" }, { code: "asc" }],
      select: { id: true, code: true, locationId: true },
    }),
    db.user.findMany({
      where:
        scope.locationIds === "ALL"
          ? {}
          : { locations: { some: { locationId: { in: [...scope.locationIds] } } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { locations, registers, cashiers };
}

// ── Detail ──────────────────────────────────────────────────────────────

const detailInclude = {
  location: { select: { name: true, timezone: true } },
  register: { select: { code: true, name: true } },
  cashier: { select: { name: true } },
  customer: { select: { name: true } },
  shift: { select: { openedAt: true, status: true } },
  review: { select: { note: true, reviewedAt: true, reviewedBy: { select: { name: true } } } },
  void: {
    select: {
      reason: true,
      note: true,
      createdAt: true,
      voidedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  },
  fiscalReceipt: { select: { status: true, lotteryCode: true, issuedAt: true, error: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      id: true,
      lineNo: true,
      name: true,
      sku: true,
      unit: true,
      qtyMilli: true,
      unitPrice: true,
      catalogUnitPrice: true,
      taxTreatment: true,
      vatRateBps: true,
      cityTaxRateBps: true,
      netAmount: true,
      vatAmount: true,
      cityTaxAmount: true,
      discountAmount: true,
      totalAmount: true,
      priceOverrideBy: { select: { name: true } },
      modifiers: { select: { name: true, priceDelta: true } },
    },
  },
  discounts: {
    orderBy: { id: "asc" },
    select: {
      scope: true,
      source: true,
      kind: true,
      amount: true,
      reason: true,
      saleLine: { select: { lineNo: true } },
      approvedBy: { select: { name: true } },
    },
  },
  payments: {
    orderBy: { createdAt: "asc" },
    select: {
      method: true,
      amount: true,
      tendered: true,
      change: true,
      reference: true,
      cardBrand: true,
      cardLast4: true,
    },
  },
  refunds: {
    orderBy: { occurredAt: "asc" },
    select: {
      id: true,
      number: true,
      occurredAt: true,
      reason: true,
      note: true,
      totalAmount: true,
      exchangeSale: { select: { id: true, number: true } },
      processedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      fiscalReceipt: { select: { status: true } },
      payments: { orderBy: { createdAt: "asc" }, select: { method: true, amount: true } },
      lines: { select: { qtyMilli: true, totalAmount: true, restock: true } },
    },
  },
} satisfies Prisma.SaleInclude;

type DetailRow = Prisma.SaleGetPayload<{ include: typeof detailInclude }>;

export interface SaleApproval {
  kind: "discount" | "priceOverride" | "void" | "refund" | "review";
  approverName: string;
  /** Line number for line-scoped approvals, refund number for refunds. */
  ref: string | null;
}

export interface SaleDetail {
  sale: DetailRow;
  status: SaleStatus;
  refundedAmount: Money;
  taxRows: ReceiptTaxRow[];
  approvals: SaleApproval[];
  audit: {
    id: string;
    action: string;
    entityType: string;
    createdAt: Date;
    actorName: string | null;
  }[];
}

export async function getSaleDetail(scope: Scope, saleId: string): Promise<SaleDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saleId)) {
    return null;
  }
  const sale = await db.sale.findUnique({ where: { id: saleId }, include: detailInclude });
  // Out of scope looks exactly like missing.
  if (!sale) return null;
  if (scope.locationIds !== "ALL" && !scope.locationIds.includes(sale.locationId)) return null;
  const refundTotals = sale.refunds.map((r) => r.totalAmount);
  const approvals: SaleApproval[] = [];
  for (const d of sale.discounts) {
    if (d.approvedBy) {
      approvals.push({
        kind: "discount",
        approverName: d.approvedBy.name,
        ref: d.saleLine ? String(d.saleLine.lineNo) : null,
      });
    }
  }
  for (const line of sale.lines) {
    if (line.priceOverrideBy) {
      approvals.push({
        kind: "priceOverride",
        approverName: line.priceOverrideBy.name,
        ref: String(line.lineNo),
      });
    }
  }
  if (sale.void?.approvedBy) {
    approvals.push({ kind: "void", approverName: sale.void.approvedBy.name, ref: null });
  }
  for (const refund of sale.refunds) {
    if (refund.approvedBy) {
      approvals.push({ kind: "refund", approverName: refund.approvedBy.name, ref: refund.number });
    }
  }
  if (sale.review) {
    approvals.push({ kind: "review", approverName: sale.review.reviewedBy.name, ref: null });
  }

  const entityIds = [sale.id, ...sale.refunds.map((r) => r.id)];
  const audit = await db.auditLog.findMany({
    where: { entityId: { in: entityIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 12,
    select: {
      id: true,
      action: true,
      entityType: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });

  return {
    sale,
    status: deriveSaleStatus({
      voided: sale.void !== null,
      saleTotal: sale.totalAmount,
      refundTotals,
    }),
    refundedAmount: refundTotals.reduce((a, b) => a + b, 0n),
    taxRows: groupTaxRows(sale.lines),
    approvals,
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      createdAt: a.createdAt,
      actorName: a.actor?.name ?? null,
    })),
  };
}
