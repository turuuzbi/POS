import "server-only";
import { IMAGE_MAX_BYTES, IMAGE_TYPES, sniffImageType } from "@/domain/product-form";
import { audit } from "../audit";
import type { Tx } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import { getStorage, type StorageProvider } from "../adapters/storage";
import type { Actor } from "./catalog";

/**
 * One image per product, kept in Product.imageUrl. The type is decided by the
 * file's magic bytes (jpeg/png/webp only), the size is capped at 2 MB, and the
 * stored name is a fresh uuid, so a URL's bytes never change.
 *
 * File I/O cannot join the database transaction: the new file is written
 * first and removed again if the row update fails; the previous file is
 * removed only after the update succeeded.
 */
export async function setProductImage(
  tx: Tx,
  productId: string,
  bytes: Uint8Array,
  actor: Actor,
  meta: Partial<RequestMeta> = {},
  storage: StorageProvider = getStorage(),
): Promise<{ imageUrl: string }> {
  if (bytes.byteLength === 0) throw fileError("required");
  if (bytes.byteLength > IMAGE_MAX_BYTES) throw fileError("tooLong");
  const type = sniffImageType(bytes);
  if (!type) throw fileError("invalid");

  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { imageUrl: true },
  });
  if (!product) throw new ActionError("NOT_FOUND");

  const key = `products/${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;
  const imageUrl = await storage.put(key, bytes, type);
  try {
    await tx.product.update({ where: { id: productId }, data: { imageUrl } });
    await audit(tx, {
      actorId: actor.id,
      action: "product.image_set",
      entityType: "Product",
      entityId: productId,
      ...meta,
    });
  } catch (error) {
    await storage.delete(imageUrl).catch(() => undefined);
    throw error;
  }
  if (product.imageUrl) await storage.delete(product.imageUrl).catch(() => undefined);
  return { imageUrl };
}

export async function removeProductImage(
  tx: Tx,
  productId: string,
  actor: Actor,
  meta: Partial<RequestMeta> = {},
  storage: StorageProvider = getStorage(),
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { imageUrl: true },
  });
  if (!product) throw new ActionError("NOT_FOUND");
  if (!product.imageUrl) return;
  await tx.product.update({ where: { id: productId }, data: { imageUrl: null } });
  await audit(tx, {
    actorId: actor.id,
    action: "product.image_remove",
    entityType: "Product",
    entityId: productId,
    ...meta,
  });
  await storage.delete(product.imageUrl).catch(() => undefined);
}

function fileError(code: string) {
  return new ActionError("VALIDATION", "invalid image", { file: [code] });
}
