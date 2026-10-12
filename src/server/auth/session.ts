import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, canAccessLocation } from "@/domain/access";
import type { Permission, Role } from "@/domain/permissions";
import { safeEqual, sha256 } from "../crypto";
import { db } from "../db";
import { readDeviceToken } from "./device";
import { auth } from "./index";

export interface CurrentUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  locale: string | null;
  /** Locations the user may act in; owners may act everywhere. */
  locationIds: "ALL" | string[];
  /** Paired device the session was opened on (PIN sign-in), if any. */
  deviceId: string | null;
}

/**
 * The authenticated user for this request, re-validated against the
 * database (active, tokenVersion, not signed out, device binding), or null.
 * Memoised per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  const sid = session?.sid;
  if (!id || !sid) return null;
  const [user, revoked] = await Promise.all([
    db.user.findUnique({
      where: { id },
      include: { locations: { select: { locationId: true } } },
    }),
    db.revokedSession.findUnique({ where: { sid }, select: { sid: true } }),
  ]);
  if (!user || !user.isActive || revoked || user.tokenVersion !== session.tokenVersion) {
    return null;
  }

  // A PIN session is bound to its paired device: it dies when the device is
  // revoked, and a copied session cookie is useless without the device cookie.
  const deviceId = session.deviceId ?? null;
  if (deviceId) {
    const [device, deviceToken] = await Promise.all([
      db.device.findUnique({
        where: { id: deviceId },
        select: { tokenHash: true, revokedAt: true },
      }),
      readDeviceToken(),
    ]);
    if (
      !device ||
      device.revokedAt ||
      !deviceToken ||
      !safeEqual(sha256(deviceToken), device.tokenHash)
    ) {
      return null;
    }
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    locale: user.locale,
    locationIds: user.role === "OWNER" ? "ALL" : user.locations.map((l) => l.locationId),
    deviceId,
  };
});

export { can, canAccessLocation };

/** For pages/layouts: redirect to sign-in when there is no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For pages/layouts: redirect to /forbidden when the permission is missing. */
export async function requirePermission(
  permission: Permission,
  locationId?: string,
): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user, permission, locationId)) redirect("/forbidden");
  return user;
}
