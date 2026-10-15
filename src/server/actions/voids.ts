"use server";

import { voidInputSchema } from "@/domain/void-contract";
import { ActionError, defineAction } from "./define-action";

/**
 * Void a sale from the current open shift. Returns the VoidResult as wire
 * JSON (bigint -> decimal strings via `toWire`); the client parses it with
 * `voidResultSchema`. STUB: implemented by the refunds/voids service slice.
 */
export const voidSaleAction = defineAction({
  name: "sales.void",
  access: "pos.sell",
  input: voidInputSchema,
  async run(): Promise<unknown> {
    throw new ActionError("INVALID_STATE", "voids not implemented");
  },
});
