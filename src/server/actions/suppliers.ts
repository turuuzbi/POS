"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supplierInputSchema, supplierItemInputSchema } from "@/domain/purchasing";
import { db } from "../db";
import {
  deleteSupplier,
  removeSupplierItem,
  saveSupplier,
  saveSupplierItem,
  setSupplierActive,
} from "../services/purchasing";
import { defineAction } from "./define-action";

const PATH = "/purchasing/suppliers";

export const saveSupplierAction = defineAction({
  name: "suppliers.save",
  access: "purchasing.manage",
  input: supplierInputSchema.extend({ id: z.uuid().optional() }),
  async run({ input, user, meta }) {
    const result = await db.$transaction((tx) => saveSupplier(tx, input, user, meta));
    revalidatePath(PATH, "layout");
    return result;
  },
});

export const setSupplierActiveAction = defineAction({
  name: "suppliers.setActive",
  access: "purchasing.manage",
  input: z.object({ id: z.uuid(), isActive: z.boolean() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => setSupplierActive(tx, input.id, input.isActive, user, meta));
    revalidatePath(PATH, "layout");
    return { ok: true };
  },
});

export const deleteSupplierAction = defineAction({
  name: "suppliers.delete",
  access: "purchasing.manage",
  input: z.object({ id: z.uuid() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => deleteSupplier(tx, input.id, user, meta));
    revalidatePath(PATH, "layout");
    return { ok: true };
  },
});

export const saveSupplierItemAction = defineAction({
  name: "suppliers.saveItem",
  access: "purchasing.manage",
  input: supplierItemInputSchema,
  async run({ input, user, meta }) {
    await db.$transaction((tx) => saveSupplierItem(tx, input, user, meta));
    revalidatePath(PATH, "layout");
    return { ok: true };
  },
});

export const removeSupplierItemAction = defineAction({
  name: "suppliers.removeItem",
  access: "purchasing.manage",
  input: z.object({ supplierId: z.uuid(), variantId: z.uuid() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) =>
      removeSupplierItem(tx, input.supplierId, input.variantId, user, meta),
    );
    revalidatePath(PATH, "layout");
    return { ok: true };
  },
});
