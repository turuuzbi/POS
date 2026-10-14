"use server";

import { revalidatePath } from "next/cache";
import { adjustmentInputSchema } from "@/domain/adjustments";
import { db } from "../db";
import { createAdjustment } from "../services/adjustments";
import { assertCan, defineAction } from "./define-action";

export const createAdjustmentAction = defineAction({
  name: "adjustments.create",
  access: "inventory.adjust",
  input: adjustmentInputSchema,
  async run({ input, user, meta }) {
    assertCan(user, "inventory.adjust", input.locationId);
    const result = await db.$transaction((tx) => createAdjustment(tx, input, user, meta));
    revalidatePath("/inventory/stock");
    revalidatePath("/inventory/adjustments");
    revalidatePath("/dashboard");
    return { id: result.id };
  },
});
