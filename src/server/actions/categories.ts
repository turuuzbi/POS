"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { categoryInputSchema } from "@/domain/catalog";
import { db } from "../db";
import { deleteCategory, saveCategory, setCategoryActive } from "../services/catalog";
import { defineAction } from "./define-action";

const PATH = "/catalog/categories";

export const saveCategoryAction = defineAction({
  name: "categories.save",
  access: "catalog.edit",
  input: categoryInputSchema.extend({ id: z.uuid().optional() }),
  async run({ input, user, meta }) {
    const result = await db.$transaction((tx) => saveCategory(tx, input, user, meta));
    revalidatePath(PATH);
    return result;
  },
});

export const setCategoryActiveAction = defineAction({
  name: "categories.setActive",
  access: "catalog.edit",
  input: z.object({ id: z.uuid(), isActive: z.boolean() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => setCategoryActive(tx, input.id, input.isActive, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});

export const deleteCategoryAction = defineAction({
  name: "categories.delete",
  access: "catalog.edit",
  input: z.object({ id: z.uuid() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => deleteCategory(tx, input.id, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});
