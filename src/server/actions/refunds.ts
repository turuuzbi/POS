"use server";

import { refundRequestSchema } from "@/domain/refund-contract";
import { ActionError, defineAction } from "./define-action";

/**
 * Refund / return / exchange against an original sale. Returns the
 * RefundResult as wire JSON (bigint -> decimal strings via `toWire`); the
 * client parses it with `refundResultSchema`. STUB: implemented by the
 * refunds/voids service slice.
 */
export const refundAction = defineAction({
  name: "refunds.create",
  access: "pos.sell",
  input: refundRequestSchema,
  async run(): Promise<unknown> {
    throw new ActionError("INVALID_STATE", "refunds not implemented");
  },
});
