"use server";

import { z } from "zod";
import { toWire } from "@/domain/checkout-contract";
import { MAX_RECEIPT_INPUT, parseReceiptInput } from "@/lib/refunds/receipt-input";
import { db } from "../db";
import {
  findReturnSale,
  listRecentSales,
  refundWindowDays,
  roundingUnit,
} from "../queries/register-sales";
import { requireRegisterContext } from "../services/register-context";
import { defineAction } from "./define-action";

/**
 * Read-only lookups for the register's Returns screen. The location and
 * register come from the paired device (same checks as checkout), never from
 * the input, so a cashier only ever reads the sales of the till they stand at.
 */

/** Find the original sale by receipt number, share link / QR text or sale id. */
export const findReturnSaleAction = defineAction({
  name: "returns.find",
  access: "pos.sell",
  input: z.object({ text: z.string().trim().min(1).max(MAX_RECEIPT_INPUT) }),
  async run({ input, user }): Promise<unknown> {
    const device = await requireRegisterContext(user);
    const key = parseReceiptInput(input.text);
    const sale = key ? await findReturnSale(device, key) : null;
    return toWire({
      sale,
      policy: { maxRefundWindowDays: refundWindowDays() },
      roundingUnit: await roundingUnit(),
    });
  },
});

/** The register's latest sales, newest first, optionally only the open shift's. */
export const listRecentSalesAction = defineAction({
  name: "returns.recent",
  access: "pos.sell",
  input: z.object({
    scope: z.enum(["SHIFT", "REGISTER"]),
    query: z.string().trim().max(40).default(""),
  }),
  async run({ input, user }): Promise<unknown> {
    const device = await requireRegisterContext(user);
    let shiftId: string | null = null;
    if (input.scope === "SHIFT") {
      const shift = await db.shift.findFirst({
        where: { registerId: device.registerId, status: "OPEN" },
        select: { id: true },
      });
      // No open shift: nothing belongs to "this shift".
      if (!shift) return toWire({ sales: [], truncated: false });
      shiftId = shift.id;
    }
    return toWire(await listRecentSales(device, { shiftId, query: input.query }));
  },
});
