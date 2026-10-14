import "server-only";
import { canAccessLocation } from "@/domain/access";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { ActionError } from "../errors";

/** The paired device and register a till action runs on; derived server-side, never from input. */
export interface RegisterContext {
  deviceId: string;
  locationId: string;
  registerId: string;
}

/**
 * Resolve the current browser's paired device. It must be active, have a
 * register, sit at a location the user may act in, and — for a PIN session —
 * be the device the session was opened on.
 */
export async function requireRegisterContext(
  user: Pick<CurrentUser, "deviceId" | "role" | "locationIds">,
): Promise<RegisterContext> {
  const device = await findActiveDevice(db, await readDeviceToken());
  if (!device || !device.registerId) throw new ActionError("DEVICE_REQUIRED");
  if (user.deviceId !== null && user.deviceId !== device.id) {
    throw new ActionError("DEVICE_REQUIRED");
  }
  if (!canAccessLocation(user, device.locationId)) throw new ActionError("FORBIDDEN");
  return { deviceId: device.id, locationId: device.locationId, registerId: device.registerId };
}
