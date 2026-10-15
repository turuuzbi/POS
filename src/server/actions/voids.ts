"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { toWire } from "@/domain/checkout-contract";
import { voidInputSchema } from "@/domain/void-contract";
import { runVoidFiscal } from "../services/post-refund";
import { requireRegisterContext } from "../services/register-context";
import { voidSale } from "../services/voids";
import { defineAction } from "./define-action";

/**
 * Void a sale from the current open shift. Returns the VoidResult as wire
 * JSON (bigint -> decimal strings via `toWire`); the client parses it with
 * `voidResultSchema`.
 *
 * Failures come back as an ActionFailure whose `fieldErrors.void[0]` is the
 * void error code (`voidCodeFromFailure`, domain/refund-failure.ts); the
 * message key is `void.errors.<CODE>` in the `refundErrors` namespace.
 */
export const voidSaleAction = defineAction({
  name: "sales.void",
  access: "pos.sell",
  input: voidInputSchema,
  async run({ input, user, meta }): Promise<unknown> {
    const device = await requireRegisterContext(user);
    const outcome = await voidSale(input, { user, device, meta });
    if (outcome.created) {
      after(() => runVoidFiscal(outcome.result.saleId));
      revalidatePath("/register");
    }
    return toWire(outcome.result);
  },
});
