"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canAccessLocation } from "@/domain/access";
import { purchaseOrderInputSchema } from "@/domain/purchasing";
import { db } from "../db";
import { savePurchaseOrder, transitionPurchaseOrder } from "../services/purchasing";
import { assertCan, defineAction } from "./define-action";

const PATH = "/purchasing/orders";

export const savePurchaseOrderAction = defineAction({
  name: "purchaseOrders.save",
  access: "purchasing.manage",
  input: purchaseOrderInputSchema.and(z.object({ id: z.uuid().optional() })),
  async run({ input, user, meta }) {
    // An order is a costed document: only people who may see costs write it.
    assertCan(user, "reports.view_costs");
    const result = await db.$transaction((tx) =>
      savePurchaseOrder(tx, input, user, meta, (id) => canAccessLocation(user, id)),
    );
    revalidatePath(PATH, "layout");
    return result;
  },
});

export const transitionPurchaseOrderAction = defineAction({
  name: "purchaseOrders.transition",
  access: "purchasing.manage",
  input: z.object({ id: z.uuid(), to: z.enum(["ORDERED", "CANCELLED", "RECEIVED"]) }),
  async run({ input, user, meta }) {
    await db.$transaction((tx) =>
      transitionPurchaseOrder(tx, input.id, input.to, user, meta, (id) =>
        canAccessLocation(user, id),
      ),
    );
    revalidatePath(PATH, "layout");
    return { ok: true };
  },
});
