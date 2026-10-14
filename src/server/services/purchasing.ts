import "server-only";
import { isValidQty } from "@/domain/qty";
import {
  canReceive,
  canTransition,
  isEditable,
  maxReceivableMilli,
  OVER_RECEIPT_TOLERANCE_BPS,
  statusAfterReceiving,
  type PurchaseOrderInput,
  type ReceiptInput,
  type SupplierInput,
  type SupplierItemInput,
} from "@/domain/purchasing";
import type { PurchaseOrderStatus } from "@/generated/prisma/client";
import { audit } from "../audit";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import { nextDocumentNumber } from "./sequence";
import { postStockMovements } from "./stock";

/**
 * Suppliers, purchase orders and receiving. Every function runs inside the
 * caller's transaction and audits there too. Stock only ever changes through
 * `postStockMovements`; this module never touches StockLevel/StockMovement.
 *
 * Lock order (receipts): purchase order, its lines (by id), the document
 * sequence row, then variants and stock levels (inside the stock service,
 * by variant id). Every path takes locks in that order, so they can't deadlock.
 */

export interface Actor {
  id: string;
}

type Meta = Partial<RequestMeta>;

/** True when the acting user may work at this location (checked against the data's location). */
export type LocationScope = (locationId: string) => boolean;

function assertScope(scope: LocationScope | undefined, locationId: string): void {
  if (scope && !scope(locationId)) throw new ActionError("FORBIDDEN");
}

// Suppliers

export async function saveSupplier(
  tx: Tx,
  input: SupplierInput & { id?: string },
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string }> {
  const { id, ...data } = input;
  if (id) {
    const before = await tx.supplier.findUnique({ where: { id } });
    if (!before) throw new ActionError("NOT_FOUND");
    await tx.supplier.update({ where: { id }, data });
    await audit(tx, {
      actorId: actor.id,
      action: "supplier.update",
      entityType: "Supplier",
      entityId: id,
      before: { name: before.name, phone: before.phone, email: before.email },
      after: { name: data.name, phone: data.phone, email: data.email },
      ...meta,
    });
    return { id };
  }
  const created = await tx.supplier.create({ data });
  await audit(tx, {
    actorId: actor.id,
    action: "supplier.create",
    entityType: "Supplier",
    entityId: created.id,
    after: { name: data.name },
    ...meta,
  });
  return { id: created.id };
}

export async function setSupplierActive(
  tx: Tx,
  id: string,
  isActive: boolean,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const { count } = await tx.supplier.updateMany({ where: { id }, data: { isActive } });
  if (count === 0) throw new ActionError("NOT_FOUND");
  await audit(tx, {
    actorId: actor.id,
    action: isActive ? "supplier.restore" : "supplier.archive",
    entityType: "Supplier",
    entityId: id,
    ...meta,
  });
}

/** Delete a supplier with no orders or receipts; otherwise IN_USE (archive instead). */
export async function deleteSupplier(
  tx: Tx,
  id: string,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const supplier = await tx.supplier.findUnique({
    where: { id },
    include: { _count: { select: { purchaseOrders: true, goodsReceipts: true } } },
  });
  if (!supplier) throw new ActionError("NOT_FOUND");
  if (supplier._count.purchaseOrders + supplier._count.goodsReceipts > 0) {
    throw new ActionError("IN_USE");
  }
  await tx.supplier.delete({ where: { id } });
  await audit(tx, {
    actorId: actor.id,
    action: "supplier.delete",
    entityType: "Supplier",
    entityId: id,
    before: { name: supplier.name },
    ...meta,
  });
}

export async function saveSupplierItem(
  tx: Tx,
  input: SupplierItemInput,
  actor: Actor,
  meta: Meta = {},
  options: { writeCost?: boolean } = {},
): Promise<void> {
  const { writeCost = true } = options;
  const [supplier, variant] = await Promise.all([
    tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } }),
    tx.productVariant.findUnique({ where: { id: input.variantId }, select: { id: true } }),
  ]);
  if (!supplier || !variant) throw new ActionError("NOT_FOUND");
  const data = {
    supplierSku: input.supplierSku,
    isPreferred: input.isPreferred,
  };
  // Without cost access the stored cost is never overwritten (null on create).
  await tx.supplierItem.upsert({
    where: { supplierId_variantId: { supplierId: input.supplierId, variantId: input.variantId } },
    create: {
      supplierId: input.supplierId,
      variantId: input.variantId,
      ...data,
      cost: writeCost ? input.cost : null,
    },
    update: writeCost ? { ...data, cost: input.cost } : data,
  });
  await audit(tx, {
    actorId: actor.id,
    action: "supplier.item_save",
    entityType: "Supplier",
    entityId: input.supplierId,
    after: { variantId: input.variantId, supplierSku: input.supplierSku },
    ...meta,
  });
}

export async function removeSupplierItem(
  tx: Tx,
  supplierId: string,
  variantId: string,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const { count } = await tx.supplierItem.deleteMany({ where: { supplierId, variantId } });
  if (count === 0) throw new ActionError("NOT_FOUND");
  await audit(tx, {
    actorId: actor.id,
    action: "supplier.item_remove",
    entityType: "Supplier",
    entityId: supplierId,
    before: { variantId },
    ...meta,
  });
}

// Purchase orders

async function lockOrder(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new ActionError("NOT_FOUND");
}

async function assertOrderableVariants(
  tx: Tx,
  lines: { variantId: string; qtyMilli: number }[],
): Promise<void> {
  const variants = await tx.productVariant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    select: {
      id: true,
      isActive: true,
      product: { select: { type: true, trackStock: true, unit: true, isActive: true } },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const line of lines) {
    const variant = byId.get(line.variantId);
    if (!variant) throw new ActionError("NOT_FOUND");
    const { product } = variant;
    if (!variant.isActive || !product.isActive) {
      throw new ActionError("VALIDATION", "inactive variant", { lines: ["inactive"] });
    }
    if (product.type !== "STANDARD" || !product.trackStock) {
      throw new ActionError("VALIDATION", "variant is not stock-tracked", { lines: ["invalid"] });
    }
    if (!isValidQty(line.qtyMilli, product.unit)) {
      throw new ActionError("VALIDATION", "invalid quantity", { lines: ["invalidQty"] });
    }
  }
}

/** Create a draft order, or replace the header and lines of an existing draft. */
export async function savePurchaseOrder(
  tx: Tx,
  input: PurchaseOrderInput & { id?: string },
  actor: Actor,
  meta: Meta = {},
  scope?: LocationScope,
): Promise<{ id: string; number: string }> {
  assertScope(scope, input.locationId);
  const [supplier, location] = await Promise.all([
    tx.supplier.findUnique({ where: { id: input.supplierId }, select: { isActive: true } }),
    tx.location.findUnique({ where: { id: input.locationId }, select: { isActive: true } }),
  ]);
  if (!supplier || !location) throw new ActionError("NOT_FOUND");
  if (!supplier.isActive) {
    throw new ActionError("VALIDATION", "inactive supplier", { supplierId: ["inactive"] });
  }
  if (!location.isActive) {
    throw new ActionError("VALIDATION", "inactive location", { locationId: ["inactive"] });
  }
  await assertOrderableVariants(tx, input.lines);

  const header = {
    supplierId: input.supplierId,
    locationId: input.locationId,
    expectedAt: input.expectedAt ? new Date(`${input.expectedAt}T00:00:00.000Z`) : null,
    note: input.note,
  };
  const lines = input.lines.map((l) => ({
    variantId: l.variantId,
    qtyOrderedMilli: l.qtyMilli,
    unitCost: l.unitCost,
  }));

  if (input.id) {
    await lockOrder(tx, input.id);
    const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: input.id } });
    assertScope(scope, before.locationId);
    if (!isEditable(before.status)) throw new ActionError("INVALID_STATE");
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: input.id } });
    await tx.purchaseOrder.update({
      where: { id: input.id },
      data: { ...header, lines: { create: lines } },
    });
    await audit(tx, {
      actorId: actor.id,
      action: "purchase_order.update",
      entityType: "PurchaseOrder",
      entityId: input.id,
      locationId: input.locationId,
      before: { supplierId: before.supplierId, locationId: before.locationId },
      after: { supplierId: input.supplierId, lines: lines.length },
      ...meta,
    });
    return { id: input.id, number: before.number };
  }

  const number = await nextDocumentNumber(tx, "purchaseOrder");
  const created = await tx.purchaseOrder.create({
    data: { ...header, number, createdById: actor.id, lines: { create: lines } },
  });
  await audit(tx, {
    actorId: actor.id,
    action: "purchase_order.create",
    entityType: "PurchaseOrder",
    entityId: created.id,
    locationId: input.locationId,
    after: { number, supplierId: input.supplierId, lines: lines.length },
    ...meta,
  });
  return { id: created.id, number };
}

/**
 * Move an order along its lifecycle: DRAFT -> ORDERED, DRAFT/ORDERED ->
 * CANCELLED, PARTIALLY_RECEIVED -> RECEIVED (close short). Receiving moves
 * the status itself.
 */
export async function transitionPurchaseOrder(
  tx: Tx,
  id: string,
  to: Extract<PurchaseOrderStatus, "ORDERED" | "CANCELLED" | "RECEIVED">,
  actor: Actor,
  meta: Meta = {},
  scope?: LocationScope,
): Promise<void> {
  await lockOrder(tx, id);
  const order = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { lines: true } } },
  });
  assertScope(scope, order.locationId);
  if (!canTransition(order.status, to)) throw new ActionError("INVALID_STATE");
  if (to === "ORDERED") {
    if (order._count.lines === 0) {
      throw new ActionError("VALIDATION", "no lines", { lines: ["required"] });
    }
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: order.supplierId } });
    if (!supplier.isActive) {
      throw new ActionError("VALIDATION", "inactive supplier", { supplierId: ["inactive"] });
    }
  }
  await tx.purchaseOrder.update({
    where: { id },
    data: { status: to, ...(to === "ORDERED" ? { orderedAt: new Date() } : {}) },
  });
  await audit(tx, {
    actorId: actor.id,
    action: `purchase_order.${to.toLowerCase()}`,
    entityType: "PurchaseOrder",
    entityId: id,
    locationId: order.locationId,
    before: { status: order.status },
    after: { status: to },
    ...meta,
  });
}

// Receiving

/** A receipt as the domain schema parses it, with the note optional for service callers. */
export type ReceiptRequest = Omit<ReceiptInput, "note"> & { note?: string | null };

export interface ReceiveOptions {
  /** False when the user may not see costs: PO lines keep the order's cost, ad-hoc lines the variant's. */
  trustInputCost?: boolean;
  /** Over-receipt tolerance in bps of the ordered quantity (default: the domain constant). */
  overReceiptBps?: number;
  scope?: LocationScope;
}

export interface ReceiveResult {
  id: string;
  number: string;
  locationId: string;
  orderStatus: PurchaseOrderStatus | null;
}

/**
 * Book goods in, against a purchase order (partial receipts allowed) or ad
 * hoc. One transaction: document, lines, stock movements (moving-average
 * cost), PO received quantities and status, supplier last cost.
 */
export async function receiveGoods(
  tx: Tx,
  input: ReceiptRequest,
  actor: Actor,
  meta: Meta = {},
  options: ReceiveOptions = {},
): Promise<ReceiveResult> {
  const { trustInputCost = true, overReceiptBps = OVER_RECEIPT_TOLERANCE_BPS, scope } = options;

  let locationId: string;
  let supplierId: string | null = input.supplierId ?? null;
  let resolved: {
    variantId: string;
    qtyMilli: number;
    unitCost: bigint;
    poLineId: string | null;
  }[];
  let orderStatus: PurchaseOrderStatus | null = null;

  if (input.purchaseOrderId) {
    await lockOrder(tx, input.purchaseOrderId);
    const order = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: input.purchaseOrderId },
    });
    assertScope(scope, order.locationId);
    if (!canReceive(order.status)) throw new ActionError("INVALID_STATE");
    locationId = order.locationId;
    supplierId = order.supplierId;
    // Lock every line (by id) so concurrent receipts see each other's quantities.
    await tx.$queryRaw`
      SELECT "id" FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = ${order.id}::uuid
      ORDER BY "id" FOR UPDATE`;
    const poLines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: order.id },
      include: { variant: { select: { product: { select: { unit: true } } } } },
    });
    const byId = new Map(poLines.map((l) => [l.id, l]));
    resolved = input.lines.map((line) => {
      const poLine = byId.get(line.purchaseOrderLineId!);
      if (!poLine) throw new ActionError("NOT_FOUND");
      if (!isValidQty(line.qtyMilli, poLine.variant.product.unit)) {
        throw new ActionError("VALIDATION", "invalid quantity", { lines: ["invalidQty"] });
      }
      if (line.qtyMilli > maxReceivableMilli(poLine, overReceiptBps)) {
        throw new ActionError("VALIDATION", "over-receipt", { lines: ["overReceipt"] });
      }
      return {
        variantId: poLine.variantId,
        qtyMilli: line.qtyMilli,
        unitCost: trustInputCost ? line.unitCost : poLine.unitCost,
        poLineId: poLine.id,
      };
    });
  } else {
    locationId = input.locationId!;
    assertScope(scope, locationId);
    const location = await tx.location.findUnique({
      where: { id: locationId },
      select: { isActive: true },
    });
    if (!location) throw new ActionError("NOT_FOUND");
    if (!location.isActive) {
      throw new ActionError("VALIDATION", "inactive location", { locationId: ["inactive"] });
    }
    if (supplierId) {
      const supplier = await tx.supplier.findUnique({
        where: { id: supplierId },
        select: { isActive: true },
      });
      if (!supplier) throw new ActionError("NOT_FOUND");
    }
    const lines = input.lines.map((l) => ({ variantId: l.variantId!, qtyMilli: l.qtyMilli }));
    await assertOrderableVariants(tx, lines);
    const costs = trustInputCost
      ? null
      : new Map(
          (
            await tx.productVariant.findMany({
              where: { id: { in: lines.map((l) => l.variantId) } },
              select: { id: true, cost: true },
            })
          ).map((v) => [v.id, v.cost]),
        );
    resolved = input.lines.map((line) => ({
      variantId: line.variantId!,
      qtyMilli: line.qtyMilli,
      unitCost: costs ? costs.get(line.variantId!)! : line.unitCost,
      poLineId: null,
    }));
  }

  const number = await nextDocumentNumber(tx, "goodsReceipt");
  const receipt = await tx.goodsReceipt.create({
    data: {
      number,
      purchaseOrderId: input.purchaseOrderId ?? null,
      supplierId,
      locationId,
      note: input.note ?? null,
      receivedById: actor.id,
      lines: {
        create: resolved.map((l) => ({
          purchaseOrderLineId: l.poLineId,
          variantId: l.variantId,
          qtyMilli: l.qtyMilli,
          unitCost: l.unitCost,
        })),
      },
    },
  });

  await postStockMovements(tx, {
    locationId,
    type: "PURCHASE_RECEIPT",
    createdById: actor.id,
    note: number,
    refs: { goodsReceiptId: receipt.id },
    updateAverageCost: true,
    lines: resolved.map((l) => ({
      variantId: l.variantId,
      qtyDeltaMilli: l.qtyMilli,
      unitCost: l.unitCost,
    })),
  });

  if (input.purchaseOrderId) {
    for (const line of resolved) {
      await tx.purchaseOrderLine.update({
        where: { id: line.poLineId! },
        data: { qtyReceivedMilli: { increment: line.qtyMilli } },
      });
    }
    const all = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: input.purchaseOrderId },
      select: { qtyOrderedMilli: true, qtyReceivedMilli: true },
    });
    orderStatus = statusAfterReceiving(all);
    await tx.purchaseOrder.update({
      where: { id: input.purchaseOrderId },
      data: { status: orderStatus },
    });
  }

  // An ad-hoc line by a user who can't enter costs carries the average cost, not a supplier price.
  const recordCost = trustInputCost || Boolean(input.purchaseOrderId);
  if (supplierId) {
    // Last cost per supplier item; sorted so concurrent receipts take row locks in one order.
    for (const line of [...resolved].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      if (recordCost) {
        await tx.$executeRaw`
          INSERT INTO "SupplierItem" ("supplierId", "variantId", "cost", "isPreferred")
          VALUES (${supplierId}::uuid, ${line.variantId}::uuid, ${line.unitCost}, false)
          ON CONFLICT ("supplierId", "variantId") DO UPDATE SET "cost" = EXCLUDED."cost"`;
      } else {
        // The line cost is only the variant's average: link the item, keep its real last cost.
        await tx.$executeRaw`
          INSERT INTO "SupplierItem" ("supplierId", "variantId", "isPreferred")
          VALUES (${supplierId}::uuid, ${line.variantId}::uuid, false)
          ON CONFLICT ("supplierId", "variantId") DO NOTHING`;
      }
    }
  }

  await audit(tx, {
    actorId: actor.id,
    action: "goods_receipt.create",
    entityType: "GoodsReceipt",
    entityId: receipt.id,
    locationId,
    after: {
      number,
      purchaseOrderId: input.purchaseOrderId ?? null,
      supplierId,
      lines: resolved.length,
      orderStatus,
    },
    ...meta,
  });
  return { id: receipt.id, number, locationId, orderStatus };
}
