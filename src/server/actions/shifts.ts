"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { moneyField } from "@/domain/catalog";
import { requireRegisterContext } from "../services/register-context";
import { openShift } from "../services/shifts";
import { defineAction } from "./define-action";

/** Open a shift with a cash float on the current device's register. */
export const openShiftAction = defineAction({
  name: "shifts.open",
  access: "pos.sell",
  input: z.object({ openingFloat: moneyField }),
  async run({ input, user, meta }): Promise<{ shiftId: string }> {
    const register = await requireRegisterContext(user);
    const result = await openShift(input, user, register, meta);
    revalidatePath("/register");
    return result;
  },
});
