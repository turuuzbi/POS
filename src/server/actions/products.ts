"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { productInputSchema } from "@/domain/catalog";
import { getStorage } from "../adapters/storage";
import { db } from "../db";
import { can } from "../auth/session";
import { deleteProduct, saveProduct, setProductActive } from "../services/catalog";
import { removeProductImage, setProductImage } from "../services/product-images";
import { defineAction } from "./define-action";

const PATH = "/catalog/products";

export const saveProductAction = defineAction({
  name: "products.save",
  access: "catalog.edit",
  input: productInputSchema.and(z.object({ id: z.uuid().optional() })),
  async run({ input, user, meta }) {
    // Opening cost is a cost figure: only people allowed to see costs may set it.
    const data = can(user, "reports.view_costs")
      ? input
      : { ...input, variants: input.variants.map((v) => ({ ...v, cost: undefined })) };
    const result = await db.$transaction((tx) => saveProduct(tx, data, user, meta));
    revalidatePath(PATH);
    return result;
  },
});

export const setProductActiveAction = defineAction({
  name: "products.setActive",
  access: "catalog.edit",
  input: z.object({ id: z.uuid(), isActive: z.boolean() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => setProductActive(tx, input.id, input.isActive, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});

export const deleteProductAction = defineAction({
  name: "products.delete",
  access: "catalog.edit",
  input: z.object({ id: z.uuid() }),
  async run({ input, user, meta }) {
    const before = await db.product.findUnique({
      where: { id: input.id },
      select: { imageUrl: true },
    });
    await db.$transaction((tx) => deleteProduct(tx, input.id, user, meta));
    if (before?.imageUrl)
      await getStorage()
        .delete(before.imageUrl)
        .catch(() => undefined);
    revalidatePath(PATH);
    return { ok: true };
  },
});

export const uploadProductImageAction = defineAction({
  name: "products.uploadImage",
  access: "catalog.edit",
  input: z.object({ productId: z.uuid(), file: z.instanceof(File) }),
  async run({ input, user, meta }) {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const result = await db.$transaction((tx) =>
      setProductImage(tx, input.productId, bytes, user, meta),
    );
    revalidatePath(PATH);
    return result;
  },
});

export const removeProductImageAction = defineAction({
  name: "products.removeImage",
  access: "catalog.edit",
  input: z.object({ productId: z.uuid() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => removeProductImage(tx, input.productId, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});
