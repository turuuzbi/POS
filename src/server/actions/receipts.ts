"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, canAccessLocation } from "@/domain/access";
import { receiptInputSchema } from "@/domain/purchasing";
import { appBaseUrl } from "../app-url";
import { db } from "../db";
import { sendSaleReceipt } from "../services/post-sale";
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

export const sendReceiptAction = defineAction({
  name: "receipts.send",
  access: "pos.sell",
  input: z.object({
    saleId: z.string().uuid(),
    channel: z.enum(["SMS", "EMAIL"]),
    destination: z.string().trim().min(1).max(255),
  }),
  /** Send the receipt link of a sale to a customer's phone / e-mail. A failed send is a result, not an error. */
  async run({ input, user }) {
    return sendSaleReceipt(input, user, await appBaseUrl());
  },
});
