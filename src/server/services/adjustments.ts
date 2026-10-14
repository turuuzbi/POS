import "server-only";
import { adjustmentValue, isDeltaAllowed, type AdjustmentInput } from "@/domain/adjustments";
import { audit } from "../audit";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import { postStockMovements, type StockLine } from "./stock";

/**
 * Manual stock adjustments. The StockAdjustment header and its ADJUSTMENT
 * movements are written in the caller's transaction; stock only moves through
 * postStockMovements. Adjustments never take a balance below zero, and each
 * movement snapshots the variant's average cost, so the value of a write-off
 * stays fixed even if the cost changes later.
 *
 * The StockAdjustment model has no document number in the schema, so none is
 * allocated here; the UI shows the date plus a short id.
 */
export async function createAdjustment(
  tx: Tx,
  input: AdjustmentInput,
  actor: { id: string },
  meta: Partial<RequestMeta> = {},
): Promise<{ id: string; movementCount: number; valueMongo: bigint }> {
  const location = await tx.location.findUnique({
    where: { id: input.locationId },
    select: { isActive: true },
  });
  if (!location) throw new ActionError("NOT_FOUND");
  if (!location.isActive) throw new ActionError("INVALID_STATE", "location is inactive");

  const adjustment = await tx.stockAdjustment.create({
    data: {
      locationId: input.locationId,
      reason: input.reason,
      note: input.note,
      createdById: actor.id,
    },
    select: { id: true },
  });

  const lines: StockLine[] = input.lines.map((line) =>
    line.mode === "set"
      ? { variantId: line.variantId, countedMilli: line.qtyMilli }
      : { variantId: line.variantId, qtyDeltaMilli: line.qtyMilli },
  );
  const posted = await postStockMovements(tx, {
    locationId: input.locationId,
    type: "ADJUSTMENT",
    createdById: actor.id,
    note: input.note,
    refs: { adjustmentId: adjustment.id },
    lines,
    forbidNegative: true,
  });

  // "Set to" lines only know their delta under the lock: check direction now.
  const badIndex = posted.findIndex((line) => !isDeltaAllowed(input.reason, line.qtyDeltaMilli));
  if (badIndex >= 0) {
    throw new ActionError("VALIDATION", "wrong direction for reason", {
      [`lines.${badIndex}.qtyMilli`]: ["invalid"],
    });
  }
  const movementIds = posted.flatMap((line) => (line.movementId ? [line.movementId] : []));
  if (movementIds.length === 0) {
    throw new ActionError("VALIDATION", "nothing to adjust", { lines: ["invalid"] });
  }

  const movements = await tx.stockMovement.findMany({
    where: { id: { in: movementIds } },
    select: { qtyDeltaMilli: true, unitCost: true },
  });
  const valueMongo = movements.reduce(
    (total, m) => total + adjustmentValue(m.qtyDeltaMilli, m.unitCost ?? 0n),
    0n,
  );

  await audit(tx, {
    actorId: actor.id,
    action: "stock.adjust",
    entityType: "StockAdjustment",
    entityId: adjustment.id,
    locationId: input.locationId,
    after: {
      reason: input.reason,
      note: input.note,
      lines: posted.map((line) => ({
        variantId: line.variantId,
        deltaMilli: line.qtyDeltaMilli,
        balanceAfterMilli: line.balanceAfterMilli,
      })),
      valueMongo: valueMongo.toString(),
    },
    ...meta,
  });
  return { id: adjustment.id, movementCount: movementIds.length, valueMongo };
}
