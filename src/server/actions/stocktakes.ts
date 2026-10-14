"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "../db";
import { ActionError } from "../errors";
import { stocktakeLocationId } from "../queries/stocktakes";
import {
  cancelStocktake,
  countLine,
  finalizeStocktake,
  scanItem,
  startStocktake,
} from "../services/stocktakes";
import { assertCan, defineAction } from "./define-action";
import type { CurrentUser } from "../auth/session";

const PATH = "/inventory/stocktakes";

/** Authorise against the stocktake's own location (never the client's claim). */
async function authorise(user: CurrentUser, stocktakeId: string): Promise<void> {
  const locationId = await stocktakeLocationId(stocktakeId);
  if (!locationId) throw new ActionError("NOT_FOUND");
  assertCan(user, "inventory.stocktake", locationId);
}

export const startStocktakeAction = defineAction({
  name: "stocktakes.start",
  access: "inventory.stocktake",
  input: z.object({
    locationId: z.uuid(),
    categoryId: z.uuid().nullish(),
    note: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => v || null),
  }),
  async run({ input, user, meta }) {
    assertCan(user, "inventory.stocktake", input.locationId);
    const result = await db.$transaction((tx) => startStocktake(tx, input, user, meta), {
      timeout: 30_000,
    });
    revalidatePath(PATH);
    return result;
  },
});

export const countStocktakeLineAction = defineAction({
  name: "stocktakes.count",
  access: "inventory.stocktake",
  input: z.object({
    stocktakeId: z.uuid(),
    variantId: z.uuid(),
    mode: z.enum(["set", "add", "clear"]),
    qtyMilli: z.number().int().min(0).max(1_000_000_000).optional(),
  }),
  async run({ input, user }) {
    await authorise(user, input.stocktakeId);
    return db.$transaction((tx) => countLine(tx, input));
  },
});

export const scanStocktakeItemAction = defineAction({
  name: "stocktakes.scan",
  access: "inventory.stocktake",
  input: z.object({ stocktakeId: z.uuid(), code: z.string().trim().min(1).max(100) }),
  async run({ input, user }) {
    await authorise(user, input.stocktakeId);
    return db.$transaction((tx) => scanItem(tx, input.stocktakeId, input.code));
  },
});

export const finalizeStocktakeAction = defineAction({
  name: "stocktakes.finalize",
  access: "inventory.stocktake",
  input: z.object({ id: z.uuid(), countAll: z.boolean().default(false) }),
  async run({ input, user, meta }) {
    await authorise(user, input.id);
    const result = await db.$transaction((tx) => finalizeStocktake(tx, input, user, meta), {
      timeout: 60_000,
    });
    revalidatePath(PATH);
    revalidatePath("/inventory");
    return result;
  },
});

export const cancelStocktakeAction = defineAction({
  name: "stocktakes.cancel",
  access: "inventory.stocktake",
  input: z.object({ id: z.uuid() }),
  async run({ input, user, meta }) {
    await authorise(user, input.id);
    await db.$transaction((tx) => cancelStocktake(tx, input.id, user, meta));
    revalidatePath(PATH);
    return { ok: true };
  },
});
