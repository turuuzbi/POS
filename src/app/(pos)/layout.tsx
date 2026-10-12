import type * as React from "react";
import { requirePermission } from "@/server/auth/session";

/** Full-screen register shell; selling requires `pos.sell`. */
export default async function PosLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("pos.sell");
  return <div className="flex min-h-dvh flex-col bg-muted/30">{children}</div>;
}
