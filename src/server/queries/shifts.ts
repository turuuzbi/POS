import "server-only";
import { can } from "@/domain/access";
import type { Money } from "@/domain/money";
import { parseReportJson } from "@/domain/report-json";
import { buildXReport, buildZReport, type ShiftReport } from "@/domain/report";
import type { Prisma } from "@/generated/prisma/client";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { loadShiftReportInput } from "../services/shift-report";

export interface OpenShift {
  id: string;
  registerId: string;
  locationId: string;
  openedAt: Date;
  openingFloat: bigint;
}

/** The open shift on the current device's register, or null. */
export async function getOpenShift(): Promise<OpenShift | null> {
  const device = await findActiveDevice(db, await readDeviceToken());
  if (!device?.registerId) return null;
  const shift = await db.shift.findFirst({
    where: { registerId: device.registerId, status: "OPEN" },
    select: { id: true, registerId: true, locationId: true, openedAt: true, openingFloat: true },
  });
  return shift;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ShiftMovementRow {
  id: string;
  type: "CASH_IN" | "CASH_OUT";
  amount: Money;
  reason: string;
  createdAt: Date;
  createdByName: string;
  approvedByName: string | null;
}

export interface ShiftDetail {
  shift: {
    id: string;
    status: "OPEN" | "CLOSED";
    locationId: string;
    locationName: string;
    registerId: string;
    registerName: string;
    openedAt: Date;
    openedByName: string;
    closedAt: Date | null;
    closedByName: string | null;
    openingFloat: Money;
    expectedCash: Money | null;
    countedCash: Money | null;
    cashVariance: Money | null;
    closingNote: string | null;
    zReportNumber: number | null;
  };
  /** The frozen Z report of a closed shift, the live X report of an open one. */
  report: ShiftReport;
  movements: ShiftMovementRow[];
  /**
   * Blind close: the viewer is a till without `reports.view` looking at its OPEN
   * shift. `report.cash` is zeroed (the sections that reveal the expected drawer cash
   * are not even sent), `shift.openingFloat` is 0 and `movements` is empty; sales and
   * tenders are intact. Render no cash section for a blind detail.
   */
  blind: boolean;
}

const NO_CASH: ShiftReport["cash"] = {
  openingFloat: 0n,
  cashSales: 0n,
  cashRefunds: 0n,
  cashIn: 0n,
  cashOut: 0n,
  changeGiven: 0n,
  expected: 0n,
};

/** Who is asking: the back office (reports.view) or the register that owns the shift. */
export interface ShiftViewer {
  user: Pick<CurrentUser, "role" | "locationIds" | "id">;
  /** The paired register's id, when asked from the till. */
  registerId?: string | null;
}

/**
 * One shift with its report, or null when it does not exist or the viewer may
 * not see it (the till sees its own register's shifts; the back office needs
 * `reports.view` at the shift's location).
 */
export async function getShiftDetail(
  viewer: ShiftViewer,
  shiftId: string,
  now: Date = new Date(),
): Promise<ShiftDetail | null> {
  const row = await db.shift.findUnique({
    where: { id: shiftId },
    include: {
      register: { select: { name: true } },
      location: { select: { name: true } },
      openedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      zReport: { select: { number: true, data: true } },
      cashMovements: {
        orderBy: { createdAt: "asc" },
        include: { createdBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
      },
    },
  });
  if (!row) return null;
  const backOffice = can(viewer.user, "reports.view", row.locationId);
  const ownTill =
    viewer.registerId === row.registerId && can(viewer.user, "pos.sell", row.locationId);
  if (!backOffice && !ownTill) return null;

  let report: ShiftReport | null = row.zReport ? parseReportJson(row.zReport.data) : null;
  if (!report) {
    // Open shift: live X report. (A closed shift without a parseable snapshot is rebuilt.)
    const input = await loadShiftReportInput(db, row.id, row.closedAt ?? now);
    report =
      row.status === "CLOSED" && row.countedCash !== null && row.closedAt
        ? buildZReport(input, {
            closedAt: row.closedAt,
            countedCash: row.countedCash,
            denominations: denominationsRecord(row.denominations),
            note: row.closingNote ?? undefined,
          })
        : buildXReport(input);
  }
  // Server-side blind close: nothing that adds up to the expected cash leaves the server.
  const blind = !backOffice && row.status === "OPEN";
  if (blind) report = { ...report, cash: NO_CASH };
  return {
    blind,
    shift: {
      id: row.id,
      status: row.status,
      locationId: row.locationId,
      locationName: row.location.name,
      registerId: row.registerId,
      registerName: row.register.name,
      openedAt: row.openedAt,
      openedByName: row.openedBy.name,
      closedAt: row.closedAt,
      closedByName: row.closedBy?.name ?? null,
      openingFloat: blind ? 0n : row.openingFloat,
      expectedCash: blind ? null : row.expectedCash,
      countedCash: row.countedCash,
      cashVariance: blind ? null : row.cashVariance,
      closingNote: row.closingNote,
      zReportNumber: row.zReport?.number ?? null,
    },
    report,
    movements: (blind ? [] : row.cashMovements).map((m) => ({
      id: m.id,
      type: m.type,
      amount: m.amount,
      reason: m.reason,
      createdAt: m.createdAt,
      createdByName: m.createdBy.name,
      approvedByName: m.approvedBy?.name ?? null,
    })),
  };
}

function denominationsRecord(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shift list + variance summary
// ---------------------------------------------------------------------------

export interface ShiftListFilters {
  /** yyyy-mm-dd (business time zone, inclusive). */
  from?: string | undefined;
  to?: string | undefined;
  registerId?: string | undefined;
  locationId?: string | undefined;
  status?: "OPEN" | "CLOSED" | undefined;
  page?: number | undefined;
}

export const SHIFTS_PAGE_SIZE = 25;
/** Ulaanbaatar is UTC+8 all year. */
const BUSINESS_OFFSET = "+08:00";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayStart(day: string): Date | null {
  if (!DAY.test(day)) return null;
  const date = new Date(`${day}T00:00:00${BUSINESS_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shiftListWhere(
  user: Pick<CurrentUser, "locationIds">,
  filters: ShiftListFilters,
): Prisma.ShiftWhereInput {
  const where: Prisma.ShiftWhereInput = {};
  if (user.locationIds !== "ALL") where.locationId = { in: [...user.locationIds] };
  if (filters.locationId) {
    where.locationId =
      user.locationIds === "ALL" || user.locationIds.includes(filters.locationId)
        ? filters.locationId
        : { in: [] };
  }
  if (filters.registerId) where.registerId = filters.registerId;
  if (filters.status) where.status = filters.status;
  const from = filters.from ? dayStart(filters.from) : null;
  const toStart = filters.to ? dayStart(filters.to) : null;
  if (from || toStart) {
    where.openedAt = {
      ...(from ? { gte: from } : {}),
      ...(toStart ? { lt: new Date(toStart.getTime() + 24 * 3600 * 1000) } : {}),
    };
  }
  return where;
}

export interface ShiftListRow {
  id: string;
  status: "OPEN" | "CLOSED";
  locationName: string;
  registerName: string;
  openedAt: Date;
  closedAt: Date | null;
  openedByName: string;
  closedByName: string | null;
  expectedCash: Money | null;
  countedCash: Money | null;
  cashVariance: Money | null;
  zReportNumber: number | null;
}

export interface VarianceSummary {
  closedCount: number;
  exactCount: number;
  shortCount: number;
  overCount: number;
  /** Σ of negative variances (a negative number). */
  shortTotal: Money;
  /** Σ of positive variances. */
  overTotal: Money;
  /** Σ of all variances. */
  net: Money;
}

export async function listShifts(
  user: Pick<CurrentUser, "role" | "locationIds">,
  filters: ShiftListFilters,
): Promise<{ rows: ShiftListRow[]; page: number; pages: number; summary: VarianceSummary }> {
  const where = shiftListWhere(user, filters);
  const total = await db.shift.count({ where });
  const pages = Math.max(1, Math.ceil(total / SHIFTS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(filters.page ?? 1)), pages);
  const closed: Prisma.ShiftWhereInput = { AND: [where, { status: "CLOSED" }] };
  const [rows, closedCount, shorts, overs] = await Promise.all([
    db.shift.findMany({
      where,
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * SHIFTS_PAGE_SIZE,
      take: SHIFTS_PAGE_SIZE,
      include: {
        register: { select: { name: true } },
        location: { select: { name: true } },
        openedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
        zReport: { select: { number: true } },
      },
    }),
    db.shift.count({ where: closed }),
    db.shift.aggregate({
      where: { AND: [closed, { cashVariance: { lt: 0n } }] },
      _sum: { cashVariance: true },
      _count: true,
    }),
    db.shift.aggregate({
      where: { AND: [closed, { cashVariance: { gt: 0n } }] },
      _sum: { cashVariance: true },
      _count: true,
    }),
  ]);
  const shortTotal = shorts._sum.cashVariance ?? 0n;
  const overTotal = overs._sum.cashVariance ?? 0n;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      locationName: r.location.name,
      registerName: r.register.name,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      openedByName: r.openedBy.name,
      closedByName: r.closedBy?.name ?? null,
      expectedCash: r.expectedCash,
      countedCash: r.countedCash,
      cashVariance: r.cashVariance,
      zReportNumber: r.zReport?.number ?? null,
    })),
    page,
    pages,
    summary: {
      closedCount,
      exactCount: closedCount - shorts._count - overs._count,
      shortCount: shorts._count,
      overCount: overs._count,
      shortTotal,
      overTotal,
      net: shortTotal + overTotal,
    },
  };
}

/** Registers the user may filter by (active, at their locations). */
export function listRegistersForFilter(user: Pick<CurrentUser, "locationIds">) {
  return db.register.findMany({
    where: user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } },
    orderBy: [{ location: { name: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, location: { select: { name: true } } },
  });
}
