"use server";

import { z } from "zod";
import { moneyField } from "@/domain/catalog";
import { uuidV7 } from "@/domain/checkout-contract";
import type { QpayInvoice, QpayStatus } from "@/domain/qpay";
import { ActionError, defineAction } from "./define-action";

/** Start a (mock) QPay invoice for part of a sale. STUB. */
export const createQpayInvoiceAction = defineAction({
  name: "payments.createQpayInvoice",
  access: "pos.sell",
  input: z.object({ saleId: uuidV7, amount: moneyField }),
  async run(): Promise<QpayInvoice> {
    throw new ActionError("INVALID_STATE", "payments not implemented");
  },
});

/** Ask the server to verify an invoice with the provider. The webhook is never trusted. STUB. */
export const checkQpayAction = defineAction({
  name: "payments.checkQpay",
  access: "pos.sell",
  input: z.object({ intentId: z.uuid() }),
  async run(): Promise<{ status: QpayStatus }> {
    throw new ActionError("INVALID_STATE", "payments not implemented");
  },
});
