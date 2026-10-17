"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { moneyField } from "@/domain/catalog";
import { reportToJson } from "@/domain/report";
import {
  cashMovementInputSchema,
  closeShiftInputSchema,
  type CashMovementResult,
  type CloseShiftResult,
} from "@/domain/shift-contract";
import { uuid, toWire } from "@/domain/checkout-contract";
import { getShiftDetail } from "../queries/shifts";
import { requireRegisterContext } from "../services/register-context";
import { closeShift, openShift, recordCashMovement } from "../services/shifts";
import { ActionError, defineAction } from "./define-action";

/** Open a shift with a cash float on the current device's register. */
export const openShiftAction = defineAction({
  name: "shifts.open",
  access: "pos.sell",
  input: z.object({ openingFloat: moneyField }),
  async run({ input, user, meta }): Promise<{ shiftId: string }> {
    const register = await requireRegisterContext(user);
    const result = await openShift(input, user, register, meta);
    revalidatePath("/register");
    return result;
  },
});

/**
 * Close the register's open shift with the counted cash by denomination.
 * Returns the CloseShiftResult as wire JSON (bigint -> decimal strings via
 * `toWire`; parse with `closeShiftResultSchema`). Failures carry the shift
 * code in `fieldErrors.shift[0]` (`shiftCodeFromFailure`).
 */
export const closeShiftAction = defineAction({
  name: "shifts.close",
  access: "pos.shift.close",
  input: closeShiftInputSchema,
  async run({ input, user, meta }): Promise<unknown> {
    const register = await requireRegisterContext(user);
    const result: CloseShiftResult = await closeShift(input, user, register, meta);
    // No revalidatePath: inside a server action it re-renders the current page, which would
    // swap the till for "open shift" under the Z report the cashier is reading (the client
    // refreshes when they are done). The back-office pages are dynamic anyway.
    return toWire(result);
  },
});

/**
 * Pay-in / pay-out on the open shift. Idempotent on `movementId`. Returns the
 * CashMovementResult as wire JSON (`cashMovementResultSchema`).
 */
export const cashMovementAction = defineAction({
  name: "shifts.cashMovement",
  access: "pos.sell",
  input: cashMovementInputSchema,
  async run({ input, user, meta }): Promise<unknown> {
    const register = await requireRegisterContext(user);
    // expectedCashAfter is null for callers without reports.view (blind close).
    const result: CashMovementResult = await recordCashMovement(input, user, register, meta);
    return toWire(result);
  },
});

/**
 * The shift's report for the register: the live X report of the open shift,
 * the frozen Z report of a closed one. Read-only; only for this register's
 * own shifts. JSON-safe (money as decimal strings, dates as ISO strings). For a
 * caller without `reports.view` the OPEN shift's detail is blind (see
 * `ShiftDetail.blind`): no expected cash, no cash components, no variance.
 */
export const shiftReportAction = defineAction({
  name: "shifts.report",
  access: "pos.sell",
  input: z.object({ shiftId: uuid }),
  async run({ input, user }): Promise<unknown> {
    const register = await requireRegisterContext(user);
    const detail = await getShiftDetail({ user, registerId: register.registerId }, input.shiftId);
    if (!detail || detail.shift.registerId !== register.registerId) {
      throw new ActionError("NOT_FOUND");
    }
    return reportToJson(detail as never);
  },
});
