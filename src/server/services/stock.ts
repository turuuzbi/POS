import "server-only";
import { v7 as uuidv7 } from "uuid";
import type { StockMovementType } from "@/generated/prisma/client";
import { isValidBalance, movingAverageCost } from "@/domain/inventory";
import { MAX_QTY_MILLI, MILLI_PER_UNIT, type QtyMilli } from "@/domain/qty";
import type { Db, Tx } from "../db";
import { ActionError } from "../errors";

/**
 * The stock ledger. `StockMovement` is the append-only source of truth;
 * `StockLevel.onHandMilli` is a cache of Σ movements per (variant, location)
 * that only this module writes, in the same transaction as the movements.
 *
 * Concurrency: the affected StockLevel rows are locked with
 * `SELECT … FOR UPDATE` in variant-id order (and, for receipts, the variant
 * rows first, also in id order), so concurrent sales, receipts and counts
 * serialise per item instead of losing updates, and can't deadlock.
 */

export type StockLine =
  /** Move stock by a signed amount. */
  | { variantId: string; qtyDeltaMilli: QtyMilli; unitCost?: bigint | null; note?: string | null }
  /** Set stock to a counted amount (stocktake); the delta is computed under the lock. */
  | { variantId: string; countedMilli: QtyMilli; note?: string | null };

export interface StockRefs {
  saleId?: string;
  refundId?: string;
  goodsReceiptId?: string;
  adjustmentId?: string;
  stocktakeId?: string;
}

export interface PostStockInput {
  locationId: string;
  type: StockMovementType;
  createdById: string;
  note?: string | null;
  refs?: StockRefs;
  lines: StockLine[];
  /** Receiving: fold each line's unit cost into the variant's moving-average cost. */
  updateAverageCost?: boolean;
  /** Refuse to take any balance below zero (INSUFFICIENT_STOCK). */
  forbidNegative?: boolean;
}

export interface PostedLine {
  variantId: string;
  /** null when a counted line matched the balance and no movement was needed. */
  movementId: string | null;
  qtyDeltaMilli: QtyMilli;
  balanceBeforeMilli: QtyMilli;
  balanceAfterMilli: QtyMilli;
}

/**
 * Apply stock lines at one location inside the caller's transaction. Lines
 * are applied in order (the same variant may appear more than once); the
 * result has one entry per line.
 */
export async function postStockMovements(tx: Tx, input: PostStockInput): Promise<PostedLine[]> {
  if (input.lines.length === 0) return [];
  const variantIds = [...new Set(input.lines.map((line) => line.variantId))].sort();

  const variants = await tx.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      cost: true,
      product: { select: { trackStock: true, type: true, unit: true } },
    },
  });
  if (variants.length !== variantIds.length) throw new ActionError("NOT_FOUND");
  const variantById = new Map(variants.map((v) => [v.id, v]));
  for (const variant of variants) {
    if (!variant.product.trackStock || variant.product.type !== "STANDARD") {
      throw new ActionError("INVALID_STATE", `variant ${variant.id} is not stock-tracked`);
    }
  }
  for (const line of input.lines) {
    const unit = variantById.get(line.variantId)!.product.unit;
    const qty = "countedMilli" in line ? line.countedMilli : line.qtyDeltaMilli;
    const ok =
      Number.isSafeInteger(qty) &&
      Math.abs(qty) <= MAX_QTY_MILLI &&
      ("countedMilli" in line ? qty >= 0 : qty !== 0) &&
      (unit !== "PIECE" || qty % MILLI_PER_UNIT === 0);
    if (!ok) throw new ActionError("VALIDATION", `invalid quantity for ${line.variantId}`);
    if ("unitCost" in line && line.unitCost != null && line.unitCost < 0n) {
      throw new ActionError("VALIDATION", "negative unit cost");
    }
  }

  // Lock order: variants (receipts only), then levels — both by variant id.
  if (input.updateAverageCost) {
    await tx.$queryRaw`
      SELECT "id" FROM "ProductVariant" WHERE "id" = ANY(${variantIds}::uuid[])
      ORDER BY "id" FOR UPDATE`;
  }
  await tx.$executeRaw`
    INSERT INTO "StockLevel" ("variantId", "locationId", "onHandMilli", "updatedAt")
    SELECT v, ${input.locationId}::uuid, 0, now() FROM unnest(${variantIds}::uuid[]) AS v
    ORDER BY v
    ON CONFLICT ("variantId", "locationId") DO NOTHING`;
  const locked = await tx.$queryRaw<{ variantId: string; onHandMilli: number }[]>`
    SELECT "variantId", "onHandMilli" FROM "StockLevel"
    WHERE "locationId" = ${input.locationId}::uuid AND "variantId" = ANY(${variantIds}::uuid[])
    ORDER BY "variantId" FOR UPDATE`;
  const balance = new Map(locked.map((row) => [row.variantId, Number(row.onHandMilli)]));

  // Stock at other locations still weighs in the (business-wide) average cost.
  const elsewhere = new Map<string, number>();
  if (input.updateAverageCost) {
    const rows = await tx.$queryRaw<{ variantId: string; total: bigint }[]>`
      SELECT "variantId", COALESCE(SUM("onHandMilli"), 0)::bigint AS "total" FROM "StockLevel"
      WHERE "variantId" = ANY(${variantIds}::uuid[]) AND "locationId" <> ${input.locationId}::uuid
      GROUP BY "variantId"`;
    for (const row of rows) elsewhere.set(row.variantId, Number(row.total));
  }
  const cost = new Map(variants.map((v) => [v.id, v.cost]));

  const posted: PostedLine[] = [];
  const movements: {
    id: string;
    variantId: string;
    qtyDeltaMilli: number;
    balanceAfterMilli: number;
    unitCost: bigint | null;
    note: string | null;
  }[] = [];
  for (const line of input.lines) {
    const before = balance.get(line.variantId)!;
    const delta = "countedMilli" in line ? line.countedMilli - before : line.qtyDeltaMilli;
    const after = before + delta;
    if (!isValidBalance(after)) throw new ActionError("VALIDATION", "balance out of range");
    if (input.forbidNegative && after < 0) {
      throw new ActionError("INSUFFICIENT_STOCK", `variant ${line.variantId}`);
    }
    const unitCost = "unitCost" in line ? (line.unitCost ?? null) : null;
    if (input.updateAverageCost && unitCost !== null && delta > 0) {
      const onHand = before + (elsewhere.get(line.variantId) ?? 0);
      cost.set(
        line.variantId,
        movingAverageCost(onHand, cost.get(line.variantId)!, delta, unitCost),
      );
    }
    balance.set(line.variantId, after);
    const movementId = delta !== 0 ? uuidv7() : null;
    posted.push({
      variantId: line.variantId,
      movementId,
      qtyDeltaMilli: delta,
      balanceBeforeMilli: before,
      balanceAfterMilli: after,
    });
    if (movementId) {
      movements.push({
        id: movementId,
        variantId: line.variantId,
        qtyDeltaMilli: delta,
        balanceAfterMilli: after,
        // Receipts record what was paid; everything else snapshots the average cost.
        unitCost: unitCost ?? cost.get(line.variantId)!,
        note: line.note ?? input.note ?? null,
      });
    }
  }

  if (movements.length > 0) {
    // One statement, in line order: seq follows the order balances were computed in.
    await tx.stockMovement.createMany({
      data: movements.map((m) => ({
        ...m,
        locationId: input.locationId,
        type: input.type,
        createdById: input.createdById,
        ...input.refs,
      })),
    });
  }

  for (const variantId of variantIds) {
    await tx.stockLevel.update({
      where: { variantId_locationId: { variantId, locationId: input.locationId } },
      data: { onHandMilli: balance.get(variantId)! },
    });
  }
  if (input.updateAverageCost) {
    for (const variant of variants) {
      const next = cost.get(variant.id)!;
      if (next !== variant.cost) {
        await tx.productVariant.update({ where: { id: variant.id }, data: { cost: next } });
      }
    }
  }
  return posted;
}

export interface LedgerMismatch {
  variantId: string;
  locationId: string;
  cachedMilli: number;
  ledgerMilli: number;
  lastBalanceMilli: number | null;
}

/**
 * Compare every StockLevel with its ledger: the cache must equal Σ movements,
 * and the latest movement's balanceAfter must equal both.
 */
export async function findLedgerMismatches(client: Db): Promise<LedgerMismatch[]> {
  const rows = await client.$queryRaw<
    {
      variantId: string;
      locationId: string;
      cached: number | null;
      ledger: bigint | null;
      last: number | null;
    }[]
  >`
    WITH ledger AS (
      SELECT DISTINCT ON ("variantId", "locationId")
        "variantId", "locationId", "balanceAfterMilli" AS "last",
        SUM("qtyDeltaMilli") OVER (PARTITION BY "variantId", "locationId") AS "total"
      FROM "StockMovement"
      ORDER BY "variantId", "locationId", "seq" DESC
    )
    SELECT COALESCE(l."variantId", m."variantId") AS "variantId",
           COALESCE(l."locationId", m."locationId") AS "locationId",
           l."onHandMilli" AS "cached", m."total" AS "ledger", m."last" AS "last"
    FROM "StockLevel" l
    FULL OUTER JOIN ledger m ON m."variantId" = l."variantId" AND m."locationId" = l."locationId"
    WHERE COALESCE(l."onHandMilli", 0) <> COALESCE(m."total", 0)
       OR (m."last" IS NOT NULL AND m."last" <> COALESCE(l."onHandMilli", 0))`;
  return rows.map((row) => ({
    variantId: row.variantId,
    locationId: row.locationId,
    cachedMilli: Number(row.cached ?? 0),
    ledgerMilli: Number(row.ledger ?? 0),
    lastBalanceMilli: row.last === null ? null : Number(row.last),
  }));
}

/** Rewrite drifted StockLevel caches from the ledger. Returns how many were fixed. */
export async function rebuildStockLevels(client: Db): Promise<number> {
  const fromLedger = await client.$executeRaw`
    INSERT INTO "StockLevel" ("variantId", "locationId", "onHandMilli", "updatedAt")
    SELECT "variantId", "locationId", SUM("qtyDeltaMilli")::int, now()
    FROM "StockMovement" GROUP BY "variantId", "locationId"
    ON CONFLICT ("variantId", "locationId")
    DO UPDATE SET "onHandMilli" = EXCLUDED."onHandMilli", "updatedAt" = now()
    WHERE "StockLevel"."onHandMilli" <> EXCLUDED."onHandMilli"`;
  const withoutLedger = await client.$executeRaw`
    UPDATE "StockLevel" l SET "onHandMilli" = 0, "updatedAt" = now()
    WHERE l."onHandMilli" <> 0 AND NOT EXISTS (
      SELECT 1 FROM "StockMovement" m
      WHERE m."variantId" = l."variantId" AND m."locationId" = l."locationId"
    )`;
  return fromLedger + withoutLedger;
}
