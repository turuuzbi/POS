import "server-only";
import { v7 as uuidv7 } from "uuid";
import { can } from "@/domain/access";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import type { CurrentUser } from "../auth/session";
import { db, type Db } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import type { RegisterContext } from "./register-context";

/**
 * Minimal shifts (Phase 2): open a shift with a cash float on a register.
 * Closing, cash in/out and Z-reports are Phase 3.
 * One OPEN shift per register is enforced by the database (partial unique
 * index `Shift_one_open_per_register`); the pre-check only gives a clean error.
 */
export async function openShift(
  input: { openingFloat: bigint },
  user: Pick<CurrentUser, "id" | "role" | "locationIds">,
  register: RegisterContext,
  meta: RequestMeta,
  client: typeof db = db,
): Promise<{ shiftId: string }> {
  if (!can(user, "pos.shift.open", register.locationId)) throw new ActionError("FORBIDDEN");
  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.shift.findFirst({
        where: { registerId: register.registerId, status: "OPEN" },
        select: { id: true },
      });
      if (existing) throw new ActionError("INVALID_STATE", "a shift is already open");
      const shift = await tx.shift.create({
        data: {
          id: uuidv7(),
          registerId: register.registerId,
          locationId: register.locationId,
          openedById: user.id,
          openingFloat: input.openingFloat,
        },
      });
      await audit(tx, {
        actorId: user.id,
        action: "shift.open",
        entityType: "Shift",
        entityId: shift.id,
        locationId: register.locationId,
        registerId: register.registerId,
        after: { openingFloat: input.openingFloat.toString() },
        meta: { deviceId: register.deviceId },
        ...meta,
      });
      return { shiftId: shift.id };
    });
  } catch (error) {
    // A concurrent opener lost the race on the partial unique index.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ActionError("INVALID_STATE", "a shift is already open");
    }
    throw error;
  }
}

export async function findOpenShift(client: Db, registerId: string) {
  return client.shift.findFirst({ where: { registerId, status: "OPEN" } });
}
