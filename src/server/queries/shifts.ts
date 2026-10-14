import "server-only";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import { db } from "../db";

export interface OpenShift {
  id: string;
  registerId: string;
  locationId: string;
  openedAt: Date;
  openingFloat: bigint;
}

/** The open shift on the current device's register, or null. */
export async function getOpenShift(): Promise<OpenShift | null> {
  const device = await findActiveDevice(db, await readDeviceToken());
  if (!device?.registerId) return null;
  const shift = await db.shift.findFirst({
    where: { registerId: device.registerId, status: "OPEN" },
    select: { id: true, registerId: true, locationId: true, openedAt: true, openingFloat: true },
  });
  return shift;
}
