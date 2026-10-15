import "server-only";
import { canAccessLocation } from "@/domain/access";
import { hasPermission, type ApprovablePermission } from "@/domain/permissions";
import { verifyApproval } from "../auth/approval";
import type { Tx } from "../db";

export type ApprovalCheck = { ok: true; approverId: string } | { ok: false; reason: "INVALID" };

/**
 * Verify a manager approval token for `permission` bound to exactly `scope`
 * and this device, then re-check on the database that the approver is still
 * active, still holds the permission and may act at the location. Used by the
 * void and refund services (checkout has its own copy for discounts).
 */
export async function checkApprovalToken(
  tx: Tx,
  token: string,
  expected: {
    permission: ApprovablePermission;
    scope: string;
    deviceId: string;
    locationId: string;
  },
  now?: Date,
): Promise<ApprovalCheck> {
  const claims = verifyApproval(
    token,
    { permission: expected.permission, scope: expected.scope, deviceId: expected.deviceId },
    now,
  );
  if (!claims) return { ok: false, reason: "INVALID" };
  const approver = await tx.user.findUnique({
    where: { id: claims.approverId },
    include: { locations: { select: { locationId: true } } },
  });
  if (!approver || !approver.isActive || !hasPermission(approver.role, expected.permission)) {
    return { ok: false, reason: "INVALID" };
  }
  const subject = {
    role: approver.role,
    locationIds:
      approver.role === "OWNER" ? ("ALL" as const) : approver.locations.map((l) => l.locationId),
  };
  if (!canAccessLocation(subject, expected.locationId)) return { ok: false, reason: "INVALID" };
  return { ok: true, approverId: approver.id };
}
