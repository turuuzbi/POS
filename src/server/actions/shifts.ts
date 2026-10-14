"use server";

import { z } from "zod";
import { moneyField } from "@/domain/catalog";
import { ActionError, defineAction } from "./define-action";

/** Open a shift with a cash float on the current device's register. STUB. */
export const openShiftAction = defineAction({
  name: "shifts.open",
  access: "pos.sell",
  input: z.object({ openingFloat: moneyField }),
  async run(): Promise<{ shiftId: string }> {
    throw new ActionError("INVALID_STATE", "shifts not implemented");
  },
});
