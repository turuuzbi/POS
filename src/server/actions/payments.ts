"use server";

import { z } from "zod";
import { moneyField } from "@/domain/catalog";
import { uuidV7 } from "@/domain/checkout-contract";
import type { QpayInvoice, QpayStatus } from "@/domain/qpay";
import { checkQpay, createQpayInvoice } from "../services/payments";
import { requireRegisterContext } from "../services/register-context";
import { defineAction } from "./define-action";

/** Start a (mock) QPay invoice for part of a sale. */
export const createQpayInvoiceAction = defineAction({
  name: "payments.createQpayInvoice",
  access: "pos.sell",
  input: z.object({ saleId: uuidV7, amount: moneyField }),
  async run({ input, user, meta }): Promise<QpayInvoice> {
    const register = await requireRegisterContext(user);
    return createQpayInvoice(input, user, register, meta);
  },
});

/** Ask the server to verify an invoice with the provider. The webhook is never trusted. */
export const checkQpayAction = defineAction({
  name: "payments.checkQpay",
  access: "pos.sell",
  input: z.object({ intentId: z.uuid() }),
  async run({ input, user }): Promise<{ status: QpayStatus }> {
    return checkQpay(input.intentId, user);
  },
});
