import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import type { PurchaseOrderStatus } from "@/domain/purchasing";

const VARIANT = {
  DRAFT: "secondary",
  ORDERED: "outline",
  PARTIALLY_RECEIVED: "default",
  RECEIVED: "success",
  CANCELLED: "destructive",
} as const satisfies Record<PurchaseOrderStatus, string>;

export async function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const t = await getTranslations("purchasing.status");
  return <Badge variant={VARIANT[status]}>{t(status)}</Badge>;
}
