import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { variantLabel } from "@/domain/catalog";
import { canAccessLocation } from "@/domain/access";
import { stockValue } from "@/domain/stock-levels";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";

type Scope = Pick<CurrentUser, "locationIds" | "role">;

export const STOCK_PAGE_SIZE = 25;

/** Prisma filter limiting a `locationId` column to the user's locations. */
function locationScope(user: Pick<CurrentUser, "locationIds">): Prisma.StockLevelWhereInput {
  return user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } };
}

const trackedProduct = { trackStock: true, type: "STANDARD" as const, isActive: true };

export interface StockRow {
  variantId: string;
  label: string;
  sku: string | null;
  unit: "PIECE" | "KG" | "LITER" | "METER";
  onHandMilli: number;
  reorderPointMilli: number | null;
  /** Average cost and value: null unless the caller may see costs. */
  avgCost: bigint | null;
  value: bigint | null;
}

export interface StockListOptions {
  locationId: string;
  q?: string;
  lowOnly?: boolean;
  page?: number;
  showCosts: boolean;
}

/** One location's stock, one row per tracked variant (never-stocked items read 0). */
export async function listStock(
  user: Scope,
  options: StockListOptions,
): Promise<{ rows: StockRow[]; total: number; page: number; pages: number }> {
  if (!canAccessLocation(user, options.locationId))
    return { rows: [], total: 0, page: 1, pages: 1 };
  const q = options.q?.trim().slice(0, 100);
  const levelHere = { locationId: options.locationId };
  const where: Prisma.ProductVariantWhereInput = {
    isActive: true,
    product: trackedProduct,
    ...(q
      ? {
          OR: [
            { product: { name: { contains: q, mode: "insensitive" } } },
            { name: { contains: q, mode: "insensitive" } },
            { sku: { startsWith: q, mode: "insensitive" } },
            { barcodes: { some: { code: q } } },
          ],
        }
      : {}),
    ...(options.lowOnly
      ? {
          stockLevels: {
            some: {
              ...levelHere,
              reorderPointMilli: { not: null },
              onHandMilli: { lte: db.stockLevel.fields.reorderPointMilli },
            },
          },
        }
      : {}),
  };
  const total = await db.productVariant.count({ where });
  const pages = Math.max(1, Math.ceil(total / STOCK_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(options.page ?? 1) || 1), pages);
  const variants = await db.productVariant.findMany({
    where,
    orderBy: [{ product: { name: "asc" } }, { position: "asc" }, { id: "asc" }],
    skip: (page - 1) * STOCK_PAGE_SIZE,
    take: STOCK_PAGE_SIZE,
    select: {
      id: true,
      name: true,
      option1: true,
      option2: true,
      option3: true,
      sku: true,
      cost: true,
      product: { select: { name: true, unit: true } },
      stockLevels: {
        where: levelHere,
        select: { onHandMilli: true, reorderPointMilli: true },
      },
    },
  });
  const rows = variants.map((v): StockRow => {
    const level = v.stockLevels[0];
    const onHandMilli = level?.onHandMilli ?? 0;
    return {
      variantId: v.id,
      label: variantLabel(v.product.name, v),
      sku: v.sku,
      unit: v.product.unit,
      onHandMilli,
      reorderPointMilli: level?.reorderPointMilli ?? null,
      avgCost: options.showCosts ? v.cost : null,
      value: options.showCosts ? stockValue(onHandMilli, v.cost) : null,
    };
  });
  return { rows, total, page, pages };
}

export async function getStockVariant(user: Scope, variantId: string, locationId: string) {
  if (!canAccessLocation(user, locationId)) return null;
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      name: true,
      option1: true,
      option2: true,
      option3: true,
      sku: true,
      cost: true,
      product: { select: { name: true, unit: true, trackStock: true } },
      stockLevels: {
        where: { locationId },
        select: { onHandMilli: true, reorderPointMilli: true, reorderQtyMilli: true },
      },
    },
  });
  if (!variant) return null;
  const level = variant.stockLevels[0];
  return {
    variantId: variant.id,
    label: variantLabel(variant.product.name, variant),
    sku: variant.sku,
    unit: variant.product.unit,
    trackStock: variant.product.trackStock,
    cost: variant.cost,
    onHandMilli: level?.onHandMilli ?? 0,
    reorderPointMilli: level?.reorderPointMilli ?? null,
    reorderQtyMilli: level?.reorderQtyMilli ?? null,
  };
}

export const LEDGER_PAGE_SIZE = 30;

/** The movement ledger for one variant at one location, newest first (by seq). */
export async function listVariantLedger(
  user: Scope,
  variantId: string,
  locationId: string,
  options: { page?: number; showCosts: boolean },
) {
  if (!canAccessLocation(user, locationId)) return { rows: [], total: 0, page: 1, pages: 1 };
  const where = { variantId, locationId };
  const total = await db.stockMovement.count({ where });
  const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(options.page ?? 1) || 1), pages);
  const movements = await db.stockMovement.findMany({
    where,
    orderBy: { seq: "desc" },
    skip: (page - 1) * LEDGER_PAGE_SIZE,
    take: LEDGER_PAGE_SIZE,
    select: {
      id: true,
      seq: true,
      type: true,
      qtyDeltaMilli: true,
      balanceAfterMilli: true,
      unitCost: true,
      note: true,
      createdAt: true,
      saleId: true,
      refundId: true,
      goodsReceiptId: true,
      adjustmentId: true,
      stocktakeId: true,
      createdBy: { select: { name: true } },
      goodsReceipt: { select: { number: true } },
      stocktake: { select: { number: true } },
      adjustment: { select: { reason: true } },
    },
  });
  const rows = movements.map((m) => ({
    id: m.id,
    seq: m.seq.toString(),
    type: m.type,
    qtyDeltaMilli: m.qtyDeltaMilli,
    balanceAfterMilli: m.balanceAfterMilli,
    unitCost: options.showCosts ? m.unitCost : null,
    note: m.note,
    createdAt: m.createdAt,
    createdByName: m.createdBy.name,
    saleId: m.saleId,
    refundId: m.refundId,
    goodsReceiptId: m.goodsReceiptId,
    goodsReceiptNumber: m.goodsReceipt?.number ?? null,
    adjustmentId: m.adjustmentId,
    adjustmentReason: m.adjustment?.reason ?? null,
    stocktakeId: m.stocktakeId,
    stocktakeNumber: m.stocktake?.number ?? null,
  }));
  return { rows, total, page, pages };
}

export type LedgerRow = Awaited<ReturnType<typeof listVariantLedger>>["rows"][number];

export interface LowStockItem {
  variantId: string;
  locationId: string;
  locationName: string;
  label: string;
  unit: "PIECE" | "KG" | "LITER" | "METER";
  onHandMilli: number;
  reorderPointMilli: number;
}

/**
 * Items at or below their reorder point across the user's locations, most
 * depleted (lowest on hand relative to the reorder point) first.
 */
export async function listLowStock(
  user: Pick<CurrentUser, "locationIds">,
  options: { limit?: number; locationId?: string } = {},
): Promise<{ total: number; items: LowStockItem[] }> {
  const where: Prisma.StockLevelWhereInput = {
    AND: [
      locationScope(user),
      options.locationId ? { locationId: options.locationId } : {},
      {
        location: { isActive: true },
        reorderPointMilli: { not: null },
        onHandMilli: { lte: db.stockLevel.fields.reorderPointMilli },
        variant: { isActive: true, product: trackedProduct },
      },
    ],
  };
  const [total, levels] = await Promise.all([
    db.stockLevel.count({ where }),
    db.stockLevel.findMany({
      where,
      orderBy: [{ onHandMilli: "asc" }, { variantId: "asc" }, { locationId: "asc" }],
      take: Math.min(options.limit ?? 8, 100),
      select: {
        variantId: true,
        locationId: true,
        onHandMilli: true,
        reorderPointMilli: true,
        location: { select: { name: true } },
        variant: {
          select: {
            name: true,
            option1: true,
            option2: true,
            option3: true,
            product: { select: { name: true, unit: true } },
          },
        },
      },
    }),
  ]);
  return {
    total,
    items: levels.map((l) => ({
      variantId: l.variantId,
      locationId: l.locationId,
      locationName: l.location.name,
      label: variantLabel(l.variant.product.name, l.variant),
      unit: l.variant.product.unit,
      onHandMilli: l.onHandMilli,
      reorderPointMilli: l.reorderPointMilli!,
    })),
  };
}

export const ADJUSTMENT_PAGE_SIZE = 25;

export async function listAdjustments(
  user: Pick<CurrentUser, "locationIds">,
  options: { locationId?: string; page?: number } = {},
) {
  const where: Prisma.StockAdjustmentWhereInput = {
    ...(user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } }),
    ...(options.locationId ? { locationId: options.locationId } : {}),
  };
  if (
    options.locationId &&
    user.locationIds !== "ALL" &&
    !user.locationIds.includes(options.locationId)
  ) {
    return { rows: [], total: 0, page: 1, pages: 1 };
  }
  const total = await db.stockAdjustment.count({ where });
  const pages = Math.max(1, Math.ceil(total / ADJUSTMENT_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(options.page ?? 1) || 1), pages);
  const rows = await db.stockAdjustment.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * ADJUSTMENT_PAGE_SIZE,
    take: ADJUSTMENT_PAGE_SIZE,
    select: {
      id: true,
      reason: true,
      note: true,
      createdAt: true,
      location: { select: { name: true } },
      createdBy: { select: { name: true } },
      _count: { select: { movements: true } },
    },
  });
  return { rows, total, page, pages };
}

export async function getAdjustment(
  user: Pick<CurrentUser, "locationIds">,
  id: string,
  showCosts: boolean,
) {
  const adjustment = await db.stockAdjustment.findUnique({
    where: { id },
    select: {
      id: true,
      locationId: true,
      reason: true,
      note: true,
      createdAt: true,
      location: { select: { name: true } },
      createdBy: { select: { name: true } },
      movements: {
        orderBy: { seq: "asc" },
        select: {
          id: true,
          variantId: true,
          qtyDeltaMilli: true,
          balanceAfterMilli: true,
          unitCost: true,
          variant: {
            select: {
              name: true,
              option1: true,
              option2: true,
              option3: true,
              sku: true,
              product: { select: { name: true, unit: true } },
            },
          },
        },
      },
    },
  });
  if (!adjustment) return null;
  if (user.locationIds !== "ALL" && !user.locationIds.includes(adjustment.locationId)) return null;
  const lines = adjustment.movements.map((m) => ({
    id: m.id,
    variantId: m.variantId,
    label: variantLabel(m.variant.product.name, m.variant),
    sku: m.variant.sku,
    unit: m.variant.product.unit,
    qtyDeltaMilli: m.qtyDeltaMilli,
    balanceAfterMilli: m.balanceAfterMilli,
    unitCost: showCosts ? m.unitCost : null,
    value: showCosts ? (BigInt(m.qtyDeltaMilli) * (m.unitCost ?? 0n)) / 1000n : null,
  }));
  return {
    id: adjustment.id,
    locationId: adjustment.locationId,
    locationName: adjustment.location.name,
    reason: adjustment.reason,
    note: adjustment.note,
    createdAt: adjustment.createdAt,
    createdByName: adjustment.createdBy.name,
    lines,
    totalValue: showCosts ? lines.reduce((sum, l) => sum + (l.value ?? 0n), 0n) : null,
  };
}
