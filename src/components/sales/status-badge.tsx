import { Ban, CircleCheck, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { SaleStatus } from "@/domain/sale-status";

const STYLE: Record<SaleStatus, { variant: "success" | "destructive" | "secondary" | "outline" }> =
  {
    COMPLETED: { variant: "success" },
    VOIDED: { variant: "destructive" },
    REFUNDED: { variant: "secondary" },
    PARTIALLY_REFUNDED: { variant: "outline" },
  };

/** Status chip: icon + text, never colour alone. */
export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const t = useTranslations("sales.status");
  const Icon = status === "COMPLETED" ? CircleCheck : status === "VOIDED" ? Ban : Undo2;
  return (
    <Badge variant={STYLE[status].variant} data-status={status}>
      <Icon aria-hidden />
      {t(status)}
    </Badge>
  );
}
