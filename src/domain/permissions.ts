/**
 * Role → permission map. Pure data, safe to import on the client to hide UI;
 * the server re-checks every permission on every mutation.
 *
 * Roles are hierarchical: OWNER ⊇ MANAGER ⊇ CASHIER.
 */

export const ROLES = ["OWNER", "MANAGER", "CASHIER"] as const;
export type Role = (typeof ROLES)[number];

const CASHIER_PERMISSIONS = [
  "pos.sell",
  "pos.hold",
  "pos.shift.open",
  "pos.shift.close",
  "catalog.view",
  "inventory.view",
  "customers.view",
  "customers.edit",
] as const;

const MANAGER_PERMISSIONS = [
  ...CASHIER_PERMISSIONS,
  "pos.price_override",
  "pos.discount.manual",
  "pos.void",
  "pos.refund",
  "pos.refund.approve",
  "pos.cash_movement",
  "catalog.edit",
  "inventory.adjust",
  "inventory.receive",
  "inventory.stocktake",
  "purchasing.manage",
  "giftcards.issue",
  "giftcards.adjust",
  "storecredit.adjust",
  "loyalty.adjust",
  "reports.view",
  "reports.view_costs",
  "devices.manage",
  "audit.view",
] as const;

const OWNER_PERMISSIONS = [
  ...MANAGER_PERMISSIONS,
  "users.manage",
  "settings.manage",
  "locations.manage",
] as const;

export type Permission = (typeof OWNER_PERMISSIONS)[number];

export const ALL_PERMISSIONS: readonly Permission[] = OWNER_PERMISSIONS;

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER_PERMISSIONS),
  MANAGER: new Set(MANAGER_PERMISSIONS),
  CASHIER: new Set(CASHIER_PERMISSIONS),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * Permissions a cashier may borrow on the spot with a manager's PIN
 * (an approval token), instead of the manager signing in.
 */
export const APPROVABLE_PERMISSIONS = [
  "pos.price_override",
  "pos.discount.manual",
  "pos.void",
  "pos.refund.approve",
  "pos.cash_movement",
] as const satisfies readonly Permission[];

export type ApprovablePermission = (typeof APPROVABLE_PERMISSIONS)[number];

export function isApprovable(permission: Permission): permission is ApprovablePermission {
  return (APPROVABLE_PERMISSIONS as readonly Permission[]).includes(permission);
}
