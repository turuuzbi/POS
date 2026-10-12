/**
 * Location-scoped authorisation (pure). The server's session helpers and the
 * action wrapper both use these, so they're tested in one place.
 */
import { hasPermission, type Permission, type Role } from "./permissions";

export interface AccessSubject {
  role: Role;
  /** Locations the user may act in; owners may act everywhere. */
  locationIds: "ALL" | readonly string[];
}

export function canAccessLocation(user: AccessSubject, locationId: string): boolean {
  return user.locationIds === "ALL" || user.locationIds.includes(locationId);
}

export function can(user: AccessSubject, permission: Permission, locationId?: string): boolean {
  return (
    hasPermission(user.role, permission) &&
    (locationId === undefined || canAccessLocation(user, locationId))
  );
}
