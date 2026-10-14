"use server";

import { checkoutInputSchema } from "@/domain/checkout-contract";
import { ActionError, defineAction } from "./define-action";

/**
 * Charge a sale. Returns the CheckoutResult as wire JSON (bigint -> decimal
 * strings via `toWire`); the client parses it with `checkoutResultSchema`.
 * STUB: the transactional implementation lands with the checkout service.
 */
export const checkoutAction = defineAction({
  name: "checkout.charge",
  access: "pos.sell",
  input: checkoutInputSchema,
  async run(): Promise<unknown> {
    throw new ActionError("INVALID_STATE", "checkout service not implemented");
  },
});
