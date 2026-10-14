"use server";

import { revalidatePath } from "next/cache";
import {
  addQuickKeyInputSchema,
  removeQuickKeyInputSchema,
  reorderQuickKeysInputSchema,
  setQuickKeyColorInputSchema,
} from "@/domain/quick-keys";
import { db } from "../db";
import {
  addQuickKey,
  removeQuickKey,
  reorderQuickKeys,
  setQuickKeyColor,
} from "../services/quick-keys";
import { defineAction } from "./define-action";

const PATH = "/catalog/quick-keys";

export const addQuickKeyAction = defineAction({
  name: "quickKeys.add",
  access: "catalog.edit",
  input: addQuickKeyInputSchema,
  async run({ input, user, meta }) {
    const result = await db.$transaction((tx) => addQuickKey(tx, input, user, meta));
    revalidatePath(PATH);
    return result;
  },
});

export const setQuickKeyColorAction = defineAction({
  name: "quickKeys.setColor",
  access: "catalog.edit",
  input: setQuickKeyColorInputSchema,
  async run({ input, user, meta }) {
    await db.$transaction((tx) => setQuickKeyColor(tx, input, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});

export const reorderQuickKeysAction = defineAction({
  name: "quickKeys.reorder",
  access: "catalog.edit",
  input: reorderQuickKeysInputSchema,
  async run({ input, user, meta }) {
    await db.$transaction((tx) => reorderQuickKeys(tx, input, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});

export const removeQuickKeyAction = defineAction({
  name: "quickKeys.remove",
  access: "catalog.edit",
  input: removeQuickKeyInputSchema,
  async run({ input, user, meta }) {
    await db.$transaction((tx) => removeQuickKey(tx, input, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});
