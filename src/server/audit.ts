import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "./db";

export interface AuditEntry {
  actorId: string | null;
  /** Dotted verb, e.g. "auth.login", "device.pair", "product.price_change". */
  action: string;
  entityType: string;
  entityId?: string | null;
  locationId?: string | null;
  registerId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  meta?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append an audit record. Pass the transaction client so the audit row
 * commits (or rolls back) atomically with the change it describes.
 */
export async function audit(client: Db, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      locationId: entry.locationId ?? null,
      registerId: entry.registerId ?? null,
      before: entry.before,
      after: entry.after,
      meta: entry.meta,
      ip: entry.ip?.slice(0, 64) ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
    },
  });
}
