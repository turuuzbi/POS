import "server-only";
import { v7 as uuidv7 } from "uuid";
import { MAX_QTY_MILLI, MILLI_PER_UNIT, isFractionalUnit, type Unit } from "@/domain/qty";
import { audit } from "../audit";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import { searchVariants } from "../queries/catalog";
import { nextDocumentNumber } from "./sequence";
import { postStockMovements, type StockLine } from "./stock";

/**
 * Stocktakes. A count starts by snapshotting the expected on-hand of every
 * in-scope item into a StocktakeLine (countedMilli = null until counted).
 * Counting a line records the on-hand at that moment (expectedMilli, taken
 * under the stock-level lock and refreshed on every recount). Finalizing
 * posts the variance counted - expected as a DELTA, so sales/receipts that
 * happened after an item was counted are preserved. Uncounted lines under
 * "count all" are an absolute set to zero against the live balance.
 * The Stocktake row is the serialisation point: line writes take it FOR
 * SHARE, finalize/cancel take it FOR UPDATE, so a finalize can't miss an
 * in-flight scan and can't run twice.
 */

interface Actor {
  id: string;
}
type Meta = Partial<RequestMeta>;

export interface StartStocktakeInput {
  locationId: string;
  categoryId?: string | null;
  note?: string | null;
}

interface LockedStocktake {
  id: string;
  status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  locationId: string;
}

async function lockStocktake(tx: Tx, id: string, exclusive: boolean): Promise<LockedStocktake> {
  const rows = exclusive
    ? await tx.$queryRaw<LockedStocktake[]>`
        SELECT "id", "status"::text AS "status", "locationId" FROM "Stocktake"
        WHERE "id" = ${id}::uuid FOR UPDATE`
    : await tx.$queryRaw<LockedStocktake[]>`
        SELECT "id", "status"::text AS "status", "locationId" FROM "Stocktake"
        WHERE "id" = ${id}::uuid FOR SHARE`;
  const row = rows[0];
  if (!row) throw new ActionError("NOT_FOUND");
  return row;
}

function assertOpen(stocktake: LockedStocktake): void {
  if (stocktake.status !== "IN_PROGRESS") {
    throw new ActionError("INVALID_STATE", `stocktake is ${stocktake.status}`);
  }
}

/** A category and all its descendants. */
async function categorySubtree(tx: Tx, categoryId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT "id" FROM "Category" WHERE "id" = ${categoryId}::uuid
      UNION
      SELECT c."id" FROM "Category" c JOIN tree t ON c."parentId" = t."id"
    )
    SELECT "id" FROM tree`;
  return rows.map((row) => row.id);
}

export async function startStocktake(
  tx: Tx,
  input: StartStocktakeInput,
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string; number: string; lineCount: number }> {
  const location = await tx.location.findUnique({ where: { id: input.locationId } });
  if (!location || !location.isActive) throw new ActionError("NOT_FOUND");
  let categoryIds: string[] | null = null;
  if (input.categoryId) {
    categoryIds = await categorySubtree(tx, input.categoryId);
    if (categoryIds.length === 0) throw new ActionError("NOT_FOUND");
  }
  const number = await nextDocumentNumber(tx, "stocktake");
  const stocktake = await tx.stocktake.create({
    data: {
      number,
      locationId: input.locationId,
      categoryId: input.categoryId ?? null,
      note: input.note ?? null,
      startedById: actor.id,
    },
  });
  // Snapshot the expected on-hand of everything in scope, in one statement.
  const lineCount = await tx.$executeRaw`
    INSERT INTO "StocktakeLine" ("id", "stocktakeId", "variantId", "expectedMilli", "updatedAt")
    SELECT gen_random_uuid(), ${stocktake.id}::uuid, v."id", COALESCE(s."onHandMilli", 0), now()
    FROM "ProductVariant" v
    JOIN "Product" p ON p."id" = v."productId"
    LEFT JOIN "StockLevel" s ON s."variantId" = v."id" AND s."locationId" = ${input.locationId}::uuid
    WHERE v."isActive" AND p."isActive" AND p."trackStock" AND p."type" = 'STANDARD'
      AND (${categoryIds}::uuid[] IS NULL OR p."categoryId" = ANY(${categoryIds}::uuid[]))`;
  await audit(tx, {
    actorId: actor.id,
    action: "stocktake.start",
    entityType: "Stocktake",
    entityId: stocktake.id,
    locationId: input.locationId,
    after: { number, categoryId: input.categoryId ?? null, lines: lineCount },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { id: stocktake.id, number, lineCount };
}

export type CountMode = "set" | "add" | "clear";

export interface CountLineInput {
  stocktakeId: string;
  variantId: string;
  mode: CountMode;
  /** set: the counted quantity; add: the quantity to add (a scan = 1 unit). */
  qtyMilli?: number;
}

export interface CountedLine {
  variantId: string;
  countedMilli: number | null;
  expectedMilli: number | null;
}

/** Record (or adjust) one counted line. Safe against concurrent scans of the same item. */
export async function countLine(tx: Tx, input: CountLineInput): Promise<CountedLine> {
  const stocktake = await lockStocktake(tx, input.stocktakeId, false);
  assertOpen(stocktake);
  const variant = await tx.productVariant.findUnique({
    where: { id: input.variantId },
    select: { product: { select: { trackStock: true, type: true, unit: true } } },
  });
  if (!variant) throw new ActionError("NOT_FOUND");
  const { trackStock, type, unit } = variant.product;
  if (!trackStock || type !== "STANDARD") throw new ActionError("INVALID_STATE");

  if (input.mode !== "clear") {
    const qty = input.qtyMilli;
    const valid =
      qty !== undefined &&
      Number.isSafeInteger(qty) &&
      qty <= MAX_QTY_MILLI &&
      (input.mode === "add" ? qty > 0 : qty >= 0) &&
      (isFractionalUnit(unit as Unit) || qty % MILLI_PER_UNIT === 0);
    if (!valid) throw new ActionError("VALIDATION", "invalid quantity", { qty: ["invalid"] });
  }

  if (input.mode !== "clear") {
    // Serialise with sales/receipts so expectedMilli is the on-hand at this instant.
    await tx.$executeRaw`
      INSERT INTO "StockLevel" ("variantId", "locationId", "onHandMilli", "updatedAt")
      VALUES (${input.variantId}::uuid, ${stocktake.locationId}::uuid, 0, now())
      ON CONFLICT ("variantId", "locationId") DO NOTHING`;
    await tx.$queryRaw`
      SELECT 1 FROM "StockLevel"
      WHERE "variantId" = ${input.variantId}::uuid AND "locationId" = ${stocktake.locationId}::uuid
      FOR UPDATE`;
  }

  const id = uuidv7();
  const base = {
    stocktakeId: input.stocktakeId,
    variantId: input.variantId,
    locationId: stocktake.locationId,
  };
  let rows: CountedLine[];
  if (input.mode === "clear") {
    rows = await tx.$queryRaw<CountedLine[]>`
      UPDATE "StocktakeLine" SET "countedMilli" = NULL, "updatedAt" = now()
      WHERE "stocktakeId" = ${base.stocktakeId}::uuid AND "variantId" = ${base.variantId}::uuid
      RETURNING "variantId", "countedMilli", "expectedMilli"`;
  } else if (input.mode === "set") {
    rows = await tx.$queryRaw<CountedLine[]>`
      INSERT INTO "StocktakeLine" ("id", "stocktakeId", "variantId", "countedMilli", "expectedMilli", "updatedAt")
      VALUES (${id}::uuid, ${base.stocktakeId}::uuid, ${base.variantId}::uuid, ${input.qtyMilli}::int,
        (SELECT COALESCE(SUM("onHandMilli"), 0)::int FROM "StockLevel"
          WHERE "variantId" = ${base.variantId}::uuid AND "locationId" = ${base.locationId}::uuid),
        now())
      ON CONFLICT ("stocktakeId", "variantId")
      DO UPDATE SET "countedMilli" = EXCLUDED."countedMilli",
                    "expectedMilli" = EXCLUDED."expectedMilli", "updatedAt" = now()
      RETURNING "variantId", "countedMilli", "expectedMilli"`;
  } else {
    rows = await tx.$queryRaw<CountedLine[]>`
      INSERT INTO "StocktakeLine" ("id", "stocktakeId", "variantId", "countedMilli", "expectedMilli", "updatedAt")
      VALUES (${id}::uuid, ${base.stocktakeId}::uuid, ${base.variantId}::uuid, ${input.qtyMilli}::int,
        (SELECT COALESCE(SUM("onHandMilli"), 0)::int FROM "StockLevel"
          WHERE "variantId" = ${base.variantId}::uuid AND "locationId" = ${base.locationId}::uuid),
        now())
      ON CONFLICT ("stocktakeId", "variantId")
      DO UPDATE SET "countedMilli" = COALESCE("StocktakeLine"."countedMilli", 0) + EXCLUDED."countedMilli",
                    "expectedMilli" = EXCLUDED."expectedMilli", "updatedAt" = now()
      RETURNING "variantId", "countedMilli", "expectedMilli"`;
  }
  const row = rows[0];
  if (!row) throw new ActionError("NOT_FOUND");
  if (row.countedMilli !== null && row.countedMilli > MAX_QTY_MILLI) {
    throw new ActionError("VALIDATION", "count too large", { qty: ["invalid"] });
  }
  return row;
}

export interface ScanHit {
  variantId: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  unit: Unit;
}

export type ScanResult =
  /** A piece item: +1 was added. */
  | { kind: "counted"; hit: ScanHit; countedMilli: number }
  /** A weighed/measured item: the operator types the quantity. */
  | { kind: "enter"; hit: ScanHit; countedMilli: number | null }
  /** Several candidates (a name search): the operator picks one. */
  | { kind: "choose"; hits: ScanHit[] }
  | { kind: "none" };

/**
 * Resolve a scanned/typed code. An exact barcode/SKU/PLU match on a piece
 * item adds one to its count; weighed items ask for the quantity instead.
 */
export async function scanItem(tx: Tx, stocktakeId: string, code: string): Promise<ScanResult> {
  const stocktake = await tx.stocktake.findUnique({
    where: { id: stocktakeId },
    select: { status: true, locationId: true },
  });
  if (!stocktake) throw new ActionError("NOT_FOUND");
  assertOpen({ id: stocktakeId, locationId: stocktake.locationId, status: stocktake.status });
  const found = await searchVariants(code, {
    locationId: stocktake.locationId,
    stockOnly: true,
    limit: 12,
  });
  const hits: ScanHit[] = found.map((h) => ({
    variantId: h.variantId,
    label: h.label,
    sku: h.sku,
    barcode: h.barcode,
    unit: h.unit,
  }));
  const exact = found.filter((h) => h.exact);
  // Only an EXACT barcode/SKU/PLU match may auto-count; any fuzzy hit is chosen by the operator.
  const only = exact.length === 1 ? exact[0]! : null;
  if (found.length === 0) return { kind: "none" };
  if (!only) return { kind: "choose", hits };
  const hit = hits.find((h) => h.variantId === only.variantId)!;
  if (isFractionalUnit(hit.unit)) {
    const existing = await tx.stocktakeLine.findUnique({
      where: { stocktakeId_variantId: { stocktakeId, variantId: hit.variantId } },
      select: { countedMilli: true },
    });
    return { kind: "enter", hit, countedMilli: existing?.countedMilli ?? null };
  }
  const line = await countLine(tx, {
    stocktakeId,
    variantId: hit.variantId,
    mode: "add",
    qtyMilli: MILLI_PER_UNIT,
  });
  return { kind: "counted", hit, countedMilli: line.countedMilli ?? 0 };
}

export interface FinalizeResult {
  posted: number;
  unchanged: number;
  skippedUncounted: number;
}

/**
 * Complete the count. Only counted lines adjust stock, unless `countAll`
 * says every uncounted in-scope item is zero on the shelf. Variance is
 * computed by the ledger under lock; the stocktake is then COMPLETED and
 * immutable.
 */
export async function finalizeStocktake(
  tx: Tx,
  input: { id: string; countAll: boolean },
  actor: Actor,
  meta: Meta = {},
): Promise<FinalizeResult> {
  const stocktake = await lockStocktake(tx, input.id, true);
  assertOpen(stocktake);
  const lines = await tx.stocktakeLine.findMany({
    // Items that stopped being stock-tracked since the count began are left alone.
    where: {
      stocktakeId: input.id,
      variant: { product: { trackStock: true, type: "STANDARD" } },
    },
    select: { id: true, variantId: true, countedMilli: true, expectedMilli: true },
  });
  const effective = lines
    .map((line) => ({ ...line, target: line.countedMilli ?? (input.countAll ? 0 : null) }))
    .filter((line): line is typeof line & { target: number } => line.target !== null);
  // Counted lines post counted - expected (movements since the count survive);
  // uncounted lines under "count all" are set to zero against the live balance.
  const plan = effective.map((line) => {
    const delta = line.countedMilli !== null ? line.target - (line.expectedMilli ?? 0) : null;
    return { line, delta };
  });
  const toPost = plan.flatMap(({ line, delta }): StockLine[] => {
    if (delta === null) return [{ variantId: line.variantId, countedMilli: 0 }];
    if (delta === 0) return [];
    return [{ variantId: line.variantId, qtyDeltaMilli: delta }];
  });
  const postedLines = await postStockMovements(tx, {
    locationId: stocktake.locationId,
    type: "STOCKTAKE",
    createdById: actor.id,
    refs: { stocktakeId: input.id },
    lines: toPost,
  });
  let cursor = 0;
  const variances: number[] = [];
  for (const { line, delta } of plan) {
    let variance: number;
    if (delta === 0) variance = 0;
    else variance = postedLines[cursor++]!.qtyDeltaMilli;
    variances.push(variance);
    await tx.stocktakeLine.update({
      where: { id: line.id },
      data: { countedMilli: line.target, varianceMilli: variance },
    });
  }
  await tx.stocktake.update({
    where: { id: input.id },
    data: { status: "COMPLETED", completedById: actor.id, completedAt: new Date() },
  });
  const result: FinalizeResult = {
    posted: variances.filter((v) => v !== 0).length,
    unchanged: variances.filter((v) => v === 0).length,
    skippedUncounted: lines.length - effective.length,
  };
  await audit(tx, {
    actorId: actor.id,
    action: "stocktake.finalize",
    entityType: "Stocktake",
    entityId: input.id,
    locationId: stocktake.locationId,
    after: { countAll: input.countAll, ...result },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return result;
}

export async function cancelStocktake(
  tx: Tx,
  id: string,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const stocktake = await lockStocktake(tx, id, true);
  assertOpen(stocktake);
  await tx.stocktake.update({ where: { id }, data: { status: "CANCELLED" } });
  await audit(tx, {
    actorId: actor.id,
    action: "stocktake.cancel",
    entityType: "Stocktake",
    entityId: id,
    locationId: stocktake.locationId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}
