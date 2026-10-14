import "server-only";
import { can } from "@/domain/access";
import {
  isPermutation,
  MAX_QUICK_KEYS_PER_TAB,
  type AddQuickKeyInput,
  type QuickKeyTab,
  type ReorderQuickKeysInput,
} from "@/domain/quick-keys";
import { audit } from "../audit";
import type { CurrentUser } from "../auth/session";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";

/**
 * Quick-key grid writes. A grid is (location, tab); all writes to one grid
 * serialise on an advisory lock so "no duplicate product" and "at most N
 * keys" hold under concurrent edits. Keys with no location (shared by all)
 * are not editable here. Every function runs in the caller's transaction.
 */

type Actor = Pick<CurrentUser, "id" | "role" | "locationIds">;
type Meta = Partial<RequestMeta>;

function assertCanEdit(actor: Actor, locationId: string): void {
  if (!can(actor, "catalog.edit", locationId)) throw new ActionError("FORBIDDEN");
}

async function lockGrid(tx: Tx, { locationId, categoryId }: QuickKeyTab): Promise<void> {
  const name = `quickkeys:${locationId}:${categoryId ?? "-"}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}

const gridWhere = ({ locationId, categoryId }: QuickKeyTab) => ({ locationId, categoryId });

/** Rewrite positions to 0..n-1 in the given order (skips rows already right). */
async function writeOrder(tx: Tx, ids: readonly string[]): Promise<void> {
  const rows = await tx.quickKey.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, position: true },
  });
  const current = new Map(rows.map((r) => [r.id, r.position]));
  for (const [position, id] of ids.entries()) {
    if (current.get(id) !== position) {
      await tx.quickKey.update({ where: { id }, data: { position } });
    }
  }
}

async function loadKey(tx: Tx, id: string, actor: Actor) {
  const key = await tx.quickKey.findUnique({ where: { id } });
  if (!key || !key.locationId) throw new ActionError("NOT_FOUND");
  assertCanEdit(actor, key.locationId);
  return { ...key, locationId: key.locationId };
}

export async function addQuickKey(
  tx: Tx,
  input: AddQuickKeyInput,
  actor: Actor,
  meta: Meta = {},
): Promise<{ id: string; position: number }> {
  assertCanEdit(actor, input.locationId);
  const [location, product, category] = await Promise.all([
    tx.location.findUnique({ where: { id: input.locationId }, select: { isActive: true } }),
    tx.product.findUnique({ where: { id: input.productId }, select: { isActive: true } }),
    input.categoryId
      ? tx.category.findUnique({ where: { id: input.categoryId }, select: { isActive: true } })
      : Promise.resolve({ isActive: true }),
  ]);
  if (!location?.isActive || !product || !category) throw new ActionError("NOT_FOUND");
  if (!product.isActive) {
    throw new ActionError("VALIDATION", "inactive product", { productId: ["inactive"] });
  }

  await lockGrid(tx, input);
  const existing = await tx.quickKey.findMany({
    where: gridWhere(input),
    select: { productId: true, position: true },
  });
  if (existing.some((k) => k.productId === input.productId)) {
    throw new ActionError("CONFLICT", "product already on this grid", { productId: ["duplicate"] });
  }
  if (existing.length >= MAX_QUICK_KEYS_PER_TAB) {
    throw new ActionError("VALIDATION", "grid is full", { productId: ["full"] });
  }
  const position = existing.reduce((max, k) => Math.max(max, k.position), -1) + 1;
  const created = await tx.quickKey.create({
    data: {
      locationId: input.locationId,
      categoryId: input.categoryId,
      productId: input.productId,
      color: input.color,
      position,
    },
  });
  await audit(tx, {
    actorId: actor.id,
    action: "quickKey.add",
    entityType: "QuickKey",
    entityId: created.id,
    locationId: input.locationId,
    after: {
      productId: input.productId,
      categoryId: input.categoryId,
      color: input.color,
      position,
    },
    ...meta,
  });
  return { id: created.id, position };
}

export async function setQuickKeyColor(
  tx: Tx,
  input: { id: string; color: string | null },
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const key = await loadKey(tx, input.id, actor);
  if (key.color === input.color) return;
  await tx.quickKey.update({ where: { id: key.id }, data: { color: input.color } });
  await audit(tx, {
    actorId: actor.id,
    action: "quickKey.color",
    entityType: "QuickKey",
    entityId: key.id,
    locationId: key.locationId,
    before: { color: key.color },
    after: { color: input.color },
    ...meta,
  });
}

/** Set a grid's order. `orderedIds` must be exactly the grid's current keys. */
export async function reorderQuickKeys(
  tx: Tx,
  input: ReorderQuickKeysInput,
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  assertCanEdit(actor, input.locationId);
  await lockGrid(tx, input);
  const keys = await tx.quickKey.findMany({
    where: gridWhere(input),
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const before = keys.map((k) => k.id);
  if (!isPermutation(before, input.orderedIds)) {
    // Someone else changed the grid; the editor must reload rather than guess.
    throw new ActionError("CONFLICT", "grid changed", { orderedIds: ["stale"] });
  }
  await writeOrder(tx, input.orderedIds);
  await audit(tx, {
    actorId: actor.id,
    action: "quickKey.reorder",
    entityType: "QuickKey",
    locationId: input.locationId,
    before: { order: before },
    after: { order: input.orderedIds, categoryId: input.categoryId },
    ...meta,
  });
}

/** Delete a key and close the gap. (QuickKey carries no history, so it is a real delete.) */
export async function removeQuickKey(
  tx: Tx,
  input: { id: string },
  actor: Actor,
  meta: Meta = {},
): Promise<void> {
  const key = await loadKey(tx, input.id, actor);
  const grid = { locationId: key.locationId, categoryId: key.categoryId };
  await lockGrid(tx, grid);
  const { count } = await tx.quickKey.deleteMany({ where: { id: key.id } });
  if (count === 0) return; // already removed by a concurrent edit
  const rest = await tx.quickKey.findMany({
    where: gridWhere(grid),
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  await writeOrder(
    tx,
    rest.map((k) => k.id),
  );
  await audit(tx, {
    actorId: actor.id,
    action: "quickKey.remove",
    entityType: "QuickKey",
    entityId: key.id,
    locationId: key.locationId,
    before: {
      productId: key.productId,
      categoryId: key.categoryId,
      color: key.color,
      position: key.position,
    },
    ...meta,
  });
}
