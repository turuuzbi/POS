"use client";

import { Ban, CheckCircle2, RotateCcw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useFormat } from "@/components/pos/use-format";
import { Badge } from "@/components/ui/badge";
import { saleState, type SaleState } from "@/lib/refunds/plan";
import type { RecentSale, ReturnSale } from "@/lib/refunds/sale-wire";

/** Badge for the refund / void state of a sale. */
export function SaleStateBadge({ state }: { state: SaleState | RecentSale["state"] }) {
  const t = useTranslations("refunds.state");
  if (state === "OK") {
    return (
      <Badge variant="outline">
        <CheckCircle2 aria-hidden /> {t("OK")}
      </Badge>
    );
  }
  if (state === "VOIDED") {
    return (
      <Badge variant="destructive">
        <Ban aria-hidden /> {t("VOIDED")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <RotateCcw aria-hidden /> {t(state)}
    </Badge>
  );
}

/** Date + time in the shop's timezone (the intl provider carries it). */
export function useDateTime() {
  const intl = useFormatter();
  return (iso: string) =>
    intl.dateTime(new Date(iso), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
}

/** Receipt number, when and who, total and state: the first thing on the Returns screen. */
export function SaleHeader({ sale, shiftNote }: { sale: ReturnSale; shiftNote: string | null }) {
  const t = useTranslations("refunds.sale");
  const format = useFormat();
  const dateTime = useDateTime();
  const state = saleState(sale);
  return (
    <header className="space-y-1" data-testid="return-sale-header">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold tabular-nums" data-testid="return-sale-number">
          {sale.number}
        </h3>
        <SaleStateBadge state={state} />
        {shiftNote ? <Badge variant="outline">{shiftNote}</Badge> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("placed", { when: dateTime(sale.occurredAt), cashier: sale.cashierName })}
      </p>
      <p className="text-sm">
        {t("total")}:{" "}
        <span className="font-semibold tabular-nums">{format.money(sale.totalAmount)}</span>
      </p>
    </header>
  );
}
