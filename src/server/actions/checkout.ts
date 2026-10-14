"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { checkoutInputSchema, toWire } from "@/domain/checkout-contract";
import { checkoutSale } from "../services/checkout";
import { runPostSale } from "../services/post-sale";
import { requireRegisterContext } from "../services/register-context";
import { defineAction } from "./define-action";

/**
 * Charge a sale. Returns the CheckoutResult as wire JSON (bigint -> decimal
 * strings via `toWire`); the client parses it with `checkoutResultSchema`.
 *
 * Failures come back as an ActionFailure whose `fieldErrors.checkout[0]` is the
 * checkout error code (read it with `checkoutCodeFromFailure`, domain/
 * checkout-failure.ts); the message key is `checkout.errors.<CODE>`.
 *
 * Register, shift, cashier and location are derived server-side (paired
 * device + open shift), never from the input. After the sale is committed the
 * fiscal receipt is created and issued in `after()`: a slow or failing
 * eBarimt can neither delay nor undo the sale.
 */
export const checkoutAction = defineAction({
  name: "checkout.charge",
  access: "pos.sell",
  input: checkoutInputSchema,
  async run({ input, user, meta }): Promise<unknown> {
    const device = await requireRegisterContext(user);
    const result = await checkoutSale(input, { user, device, meta });
    after(() => runPostSale(result.saleId));
    if (!result.replayed) revalidatePath("/register");
    return toWire(result);
  },
});
