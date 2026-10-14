"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { taxClassInputSchema } from "@/domain/catalog";
import { db } from "../db";
import { saveTaxClass, setTaxClassActive } from "../services/catalog";
import { defineAction } from "./define-action";

const PATH = "/settings/tax-classes";

export const saveTaxClassAction = defineAction({
  name: "taxClasses.save",
  access: "settings.manage",
  input: taxClassInputSchema.extend({ id: z.uuid().optional() }),
  async run({ input, user, meta }) {
    const result = await db.$transaction((tx) => saveTaxClass(tx, input, user, meta));
    revalidatePath(PATH);
    return result;
  },
});

export const setTaxClassActiveAction = defineAction({
  name: "taxClasses.setActive",
  access: "settings.manage",
  input: z.object({ id: z.uuid(), isActive: z.boolean() }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) => setTaxClassActive(tx, input.id, input.isActive, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});
