import "server-only";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";

/** Prisma filter for the locations this user may act in. */
export function userLocationFilter(user: Pick<CurrentUser, "locationIds">) {
  return user.locationIds === "ALL" ? {} : { id: { in: [...user.locationIds] } };
}

/** Active locations this user may act in, by name. */
export function listUserLocations(user: Pick<CurrentUser, "locationIds">) {
  return db.location.findMany({
    where: { isActive: true, ...userLocationFilter(user) },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });
}

/**
 * The location a page should show: the requested one if the user may see it,
 * else the device's location, else their first. null when they have none.
 */
export async function resolveLocation(
  user: Pick<CurrentUser, "locationIds">,
  requested: string | null | undefined,
  preferred?: string | null,
) {
  const locations = await listUserLocations(user);
  const pick =
    locations.find((l) => l.id === requested) ??
    locations.find((l) => l.id === preferred) ??
    locations[0] ??
    null;
  return { locations, location: pick };
}
