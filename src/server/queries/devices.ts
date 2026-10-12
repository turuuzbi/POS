import "server-only";
import type { CurrentUser } from "../auth/session";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import { db } from "../db";

function locationScope(user: CurrentUser) {
  return user.locationIds === "ALL" ? {} : { id: { in: user.locationIds } };
}

/** Active locations (with active registers) this user may pair devices at. */
export function listPairableLocations(user: CurrentUser) {
  return db.location.findMany({
    where: { isActive: true, ...locationScope(user) },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      registers: {
        where: { isActive: true },
        orderBy: { code: "asc" },
        select: { id: true, name: true, code: true },
      },
    },
  });
}

/** Devices at the user's locations, newest first. */
export function listDevices(user: CurrentUser) {
  return db.device.findMany({
    where: { location: locationScope(user) },
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { pairedAt: "desc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      pairedAt: true,
      lastSeenAt: true,
      revokedAt: true,
      location: { select: { name: true } },
      register: { select: { name: true } },
    },
  });
}

/** The device this browser is paired as, if any. */
export async function currentDevice() {
  const device = await findActiveDevice(db, await readDeviceToken());
  return device
    ? {
        id: device.id,
        name: device.name,
        locationName: device.location.name,
        registerName: device.register?.name ?? null,
      }
    : null;
}
