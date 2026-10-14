import "server-only";
import { variantLabel } from "@/domain/catalog";
import { countVariance, summarizeVariance, varianceValue } from "@/domain/inventory";
import type { Unit } from "@/domain/qty";
import type { StocktakeStatus } from "@/generated/prisma/client";
import { db } from "../db";
import type { CurrentUser } from "../auth/session";

export async function listStocktakes(user: Pick<CurrentUser, "locationIds">) {
  const locationFilter =
    user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } };
  const rows = await db.stocktake.findMany({
    where: locationFilter,
    orderBy: { startedAt: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      status: true,
      startedAt: true,
      completedAt: true,
      location: { select: { name: true } },
      category: { select: { name: true } },
      startedBy: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });
  const counted = await db.stocktakeLine.groupBy({
    by: ["stocktakeId"],
    where: { stocktakeId: { in: rows.map((r) => r.id) }, countedMilli: { not: null } },
    _count: { _all: true },
  });
  const countedBy = new Map(counted.map((c) => [c.stocktakeId, c._count._all]));
  return rows.map((row) => ({ ...row, countedLines: countedBy.get(row.id) ?? 0 }));
}

export type StocktakeListRow = Awaited<ReturnType<typeof listStocktakes>>[number];

/** Category choices for scoping a count. */
export function listCountCategories() {
  return db.category.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function stocktakeLocationId(id: string): Promise<string | null> {
  const row = await db.stocktake.findUnique({ where: { id }, select: { locationId: true } });
  return row?.locationId ?? null;
}

export interface StocktakeLineView {
  variantId: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  unit: Unit;
  /** On hand when the line joined the count. */
  expectedMilli: number;
  /** On hand right now (open counts) — what finalize will compare against. */
  liveMilli: number;
  countedMilli: number | null;
  /** counted − live while open; the posted delta once completed. null = not counted. */
  varianceMilli: number | null;
  /** Variance value; null without reports.view_costs or when not counted. */
  value: bigint | null;
}

export interface StocktakeView {
  id: string;
  number: string;
  status: StocktakeStatus;
  note: string | null;
  location: { id: string; name: string };
  category: { name: string } | null;
  startedBy: string;
  startedAt: Date;
  completedBy: string | null;
  completedAt: Date | null;
  lines: StocktakeLineView[];
  summary: {
    counted: number;
    uncounted: number;
    surplusLines: number;
    shortageLines: number;
    surplusMilli: number;
    shortageMilli: number;
    netValue: bigint | null;
  };
}

/** One stocktake with its lines. Costs and values are included only when `showCosts`. */
export async function getStocktake(
  id: string,
  user: Pick<CurrentUser, "locationIds">,
  showCosts: boolean,
): Promise<StocktakeView | null> {
  const stocktake = await db.stocktake.findFirst({
    where: {
      id,
      ...(user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } }),
    },
    include: {
      location: { select: { id: true, name: true } },
      category: { select: { name: true } },
      startedBy: { select: { name: true } },
      completedBy: { select: { name: true } },
      lines: {
        include: {
          variant: {
            select: {
              name: true,
              option1: true,
              option2: true,
              option3: true,
              sku: true,
              cost: true,
              product: { select: { name: true, unit: true } },
              barcodes: { select: { code: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!stocktake) return null;

  const variantIds = stocktake.lines.map((l) => l.variantId);
  const open = stocktake.status === "IN_PROGRESS";
  const [levels, movements] = await Promise.all([
    open
      ? db.stockLevel.findMany({
          where: { locationId: stocktake.locationId, variantId: { in: variantIds } },
          select: { variantId: true, onHandMilli: true },
        })
      : [],
    // Completed counts are valued at the cost snapshotted on their movements.
    !open && showCosts
      ? db.stockMovement.findMany({
          where: { stocktakeId: id },
          select: { variantId: true, unitCost: true },
        })
      : [],
  ]);
  const live = new Map(levels.map((l) => [l.variantId, l.onHandMilli]));
  const movementCost = new Map(movements.map((m) => [m.variantId, m.unitCost]));

  const lines: (StocktakeLineView & { _cost: bigint })[] = stocktake.lines
    .map((line) => {
      const v = line.variant;
      const expected = line.expectedMilli ?? 0;
      const liveMilli = open ? (live.get(line.variantId) ?? 0) : expected;
      const variance = open
        ? line.countedMilli === null
          ? null
          : countVariance(liveMilli, line.countedMilli)
        : line.varianceMilli;
      const unitCost = open ? v.cost : (movementCost.get(line.variantId) ?? v.cost);
      return {
        variantId: line.variantId,
        label: variantLabel(v.product.name, v),
        sku: v.sku,
        barcode: v.barcodes[0]?.code ?? null,
        unit: v.product.unit as Unit,
        expectedMilli: expected,
        liveMilli,
        countedMilli: line.countedMilli,
        varianceMilli: variance,
        value: showCosts && variance !== null ? varianceValue(variance, unitCost ?? 0n) : null,
        _cost: unitCost ?? 0n,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const summary = summarizeVariance(
    lines.map((l) => ({
      // Open: compare with live stock. Completed: the stored delta is authoritative.
      expectedMilli:
        stocktake.status === "COMPLETED" && l.countedMilli !== null && l.varianceMilli !== null
          ? l.countedMilli - l.varianceMilli
          : l.liveMilli,
      countedMilli: l.countedMilli,
      unitCost: l._cost,
    })),
    false,
  );
  return {
    id: stocktake.id,
    number: stocktake.number,
    status: stocktake.status,
    note: stocktake.note,
    location: stocktake.location,
    category: stocktake.category,
    startedBy: stocktake.startedBy.name,
    startedAt: stocktake.startedAt,
    completedBy: stocktake.completedBy?.name ?? null,
    completedAt: stocktake.completedAt,
    lines: lines.map(({ _cost, ...line }) => {
      void _cost;
      return line;
    }),
    summary: { ...summary, netValue: showCosts ? summary.netValue : null },
  };
}
