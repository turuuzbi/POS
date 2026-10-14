"use server";

import { revalidatePath } from "next/cache";
import { can, canAccessLocation } from "@/domain/access";
import { receiptInputSchema } from "@/domain/purchasing";
import { db } from "../db";
import { receiveGoods } from "../services/purchasing";
import { defineAction } from "./define-action";

export const receiveGoodsAction = defineAction({
  name: "receipts.receive",
  access: "inventory.receive",
  input: receiptInputSchema,
  async run({ input, user, meta }) {
    const result = await db.$transaction(
      (tx) =>
        receiveGoods(tx, input, user, meta, {
          trustInputCost: can(user, "reports.view_costs"),
          scope: (id) => canAccessLocation(user, id),
        }),
      { timeout: 30_000 },
    );
    revalidatePath("/purchasing", "layout");
    revalidatePath("/inventory", "layout");
    return { id: result.id, number: result.number };
  },
});
