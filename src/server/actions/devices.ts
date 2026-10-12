"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "../audit";
import {
  clearDeviceCookie,
  createDevice,
  findActiveDevice,
  readDeviceToken,
  setDeviceCookie,
} from "../auth/device";
import { db } from "../db";
import { ActionError, assertCan, defineAction } from "./define-action";

/** Pair the current browser with a location (and optionally a register). */
export const pairThisDevice = defineAction({
  name: "devices.pairThisDevice",
  access: "devices.manage",
  input: z.object({
    name: z.string().trim().min(1).max(80),
    locationId: z.uuid(),
    registerId: z.uuid().nullable(),
  }),
  async run({ input, user, meta }) {
    assertCan(user, "devices.manage", input.locationId);
    const location = await db.location.findUnique({ where: { id: input.locationId } });
    if (!location?.isActive) throw new ActionError("NOT_FOUND");
    if (input.registerId) {
      const register = await db.register.findUnique({ where: { id: input.registerId } });
      if (!register?.isActive || register.locationId !== input.locationId) {
        throw new ActionError("NOT_FOUND");
      }
    }

    const previousToken = await readDeviceToken();
    const { device, token } = await db.$transaction(async (tx) => {
      // Re-pairing replaces this browser's previous pairing.
      const previous = await findActiveDevice(tx, previousToken);
      if (previous) {
        await tx.device.update({ where: { id: previous.id }, data: { revokedAt: new Date() } });
      }
      const created = await createDevice(tx, { ...input, pairedById: user.id });
      await audit(tx, {
        actorId: user.id,
        action: "device.pair",
        entityType: "Device",
        entityId: created.device.id,
        locationId: input.locationId,
        registerId: input.registerId,
        after: { name: input.name, replaced: previous?.id ?? null },
        ...meta,
      });
      return created;
    });
    await setDeviceCookie(token);
    revalidatePath("/settings/devices");
    return { deviceId: device.id };
  },
});

/** Revoke any device (lost/stolen tablet). Its PIN sessions stop working immediately. */
export const revokeDevice = defineAction({
  name: "devices.revoke",
  access: "devices.manage",
  input: z.object({ deviceId: z.uuid() }),
  async run({ input, user, meta }) {
    const device = await db.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new ActionError("NOT_FOUND");
    assertCan(user, "devices.manage", device.locationId);
    if (!device.revokedAt) {
      await db.$transaction(async (tx) => {
        await tx.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
        await audit(tx, {
          actorId: user.id,
          action: "device.revoke",
          entityType: "Device",
          entityId: device.id,
          locationId: device.locationId,
          registerId: device.registerId,
          ...meta,
        });
      });
    }
    // Revoking the device you're holding also forgets it locally.
    const current = await findActiveDevice(db, await readDeviceToken());
    if (!current) await clearDeviceCookie();
    revalidatePath("/settings/devices");
    return { revoked: true };
  },
});
