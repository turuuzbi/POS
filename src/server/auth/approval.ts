import "server-only";
import { z } from "zod";
import {
  hasPermission,
  type ApprovablePermission,
  APPROVABLE_PERMISSIONS,
} from "@/domain/permissions";
import { audit } from "../audit";
import { deriveKey, hmacSha256, safeEqual } from "../crypto";
import type { Db } from "../db";
import { env } from "../env";
import { verifyDevicePin } from "./credentials";

/**
 * Manager approval tokens. A cashier who lacks a permission (price override,
 * void, refund…) asks a manager to type their PIN on the same paired device.
 * The server returns a short-lived token bound to: the approver, the
 * permission, a scope (e.g. the client sale id) and the device. The action
 * that consumes it verifies all four and records the approver on the row.
 */

export const APPROVAL_TTL_SECONDS = 5 * 60;

const claimsSchema = z.object({
  v: z.literal(1),
  approverId: z.uuid(),
  permission: z.enum(APPROVABLE_PERMISSIONS),
  scope: z.string().min(1).max(200),
  deviceId: z.uuid(),
  exp: z.number().int(),
});

export type ApprovalClaims = z.infer<typeof claimsSchema>;

function signingKey(): Buffer {
  return deriveKey(env().AUTH_SECRET, "approval-token");
}

export function signApproval(claims: Omit<ApprovalClaims, "v" | "exp">, now = new Date()): string {
  const payload: ApprovalClaims = {
    v: 1,
    ...claims,
    exp: Math.floor(now.getTime() / 1000) + APPROVAL_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmacSha256(signingKey(), body)}`;
}

/** Returns the claims if the token is authentic, unexpired and matches every binding. */
export function verifyApproval(
  token: string,
  expected: { permission: ApprovablePermission; scope: string; deviceId: string },
  now = new Date(),
): ApprovalClaims | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, hmacSha256(signingKey(), body))) return null;
  let claims: ApprovalClaims;
  try {
    const parsed = claimsSchema.safeParse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    claims = parsed.data;
  } catch {
    return null;
  }
  if (claims.exp * 1000 <= now.getTime()) return null;
  if (
    claims.permission !== expected.permission ||
    claims.scope !== expected.scope ||
    claims.deviceId !== expected.deviceId
  ) {
    return null;
  }
  return claims;
}

/**
 * Verify an approver's PIN on this device and issue an approval token.
 * The approver must hold the permission and have access to the device's location.
 */
export async function grantApproval(
  client: Db,
  input: {
    pin: string;
    deviceToken: string | null;
    permission: ApprovablePermission;
    scope: string;
    requestedById: string;
  },
  ctx: { now?: Date; ip?: string | null; userAgent?: string | null } = {},
): Promise<
  | { ok: true; token: string; approverName: string }
  | { ok: false; reason: "INVALID" | "DEVICE_REQUIRED" | "NOT_PERMITTED" }
> {
  const result = await verifyDevicePin(
    client,
    { pin: input.pin, deviceToken: input.deviceToken },
    ctx,
  );
  if (!result.ok) return result;
  const { user, device } = result;
  if (!hasPermission(user.role, input.permission)) {
    await audit(client, {
      actorId: user.id,
      action: "approval.denied",
      entityType: "Approval",
      entityId: input.scope,
      locationId: device.locationId,
      registerId: device.registerId,
      meta: { permission: input.permission, requestedById: input.requestedById },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: "NOT_PERMITTED" };
  }
  const token = signApproval(
    { approverId: user.id, permission: input.permission, scope: input.scope, deviceId: device.id },
    ctx.now,
  );
  await audit(client, {
    actorId: user.id,
    action: "approval.granted",
    entityType: "Approval",
    entityId: input.scope,
    locationId: device.locationId,
    registerId: device.registerId,
    meta: { permission: input.permission, requestedById: input.requestedById, deviceId: device.id },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { ok: true, token, approverName: user.name };
}
