"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { checkoutInputSchema, toWire } from "@/domain/checkout-contract";
import { refundRequestSchema } from "@/domain/refund-contract";
import { runRefundFiscal } from "../services/post-refund";
import { runPostSale } from "../services/post-sale";
import { requireRegisterContext } from "../services/register-context";
import { refundSale } from "../services/refunds";
import { defineAction } from "./define-action";

/**
 * Refund / return / exchange against an original sale. Returns the
 * RefundResult as wire JSON (bigint -> decimal strings via `toWire`); the
 * client parses it with `refundResultSchema`.
 *
 * Input: `refundRequestSchema` plus, for an exchange only, `exchangeCheckout`:
 * the ordinary checkout input of the replacement sale (its `saleId` and
 * `expectedPayable` must equal `exchange.saleId` / `exchange.expectedPayable`;
 * its tenders cover the NET DUE only, the credit is added server-side).
 *
 * Failures come back as an ActionFailure whose `fieldErrors.refund[0]` is the
 * refund error code (`refundCodeFromFailure`, domain/refund-failure.ts); the
 * message key is `refund.errors.<CODE>` in the `refundErrors` namespace.
 *
 * Register, shift, cashier and location are derived server-side. Fiscal
 * returns run in `after()`: a slow eBarimt can neither delay nor undo a refund.
 */
export const refundAction = defineAction({
  name: "refunds.create",
  access: "pos.sell",
  input: refundRequestSchema.safeExtend({ exchangeCheckout: checkoutInputSchema.optional() }),
  async run({ input, user, meta }): Promise<unknown> {
    const device = await requireRegisterContext(user);
    const { exchangeCheckout, ...refund } = input;
    const outcome = await refundSale(refund, { user, device, meta }, { exchangeCheckout });
    if (outcome.created) {
      after(async () => {
        await runRefundFiscal(outcome.result.refundId);
        if (outcome.exchangeSaleId) await runPostSale(outcome.exchangeSaleId);
      });
      revalidatePath("/register");
    }
    return toWire(outcome.result);
  },
});
