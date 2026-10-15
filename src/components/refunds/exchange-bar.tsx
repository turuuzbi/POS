"use client";

import { Repeat2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormat } from "@/components/pos/use-format";
import type { ExchangeHandle } from "@/components/refunds/use-exchange";
import { Button } from "@/components/ui/button";

/**
 * Shown above the register while an exchange is in progress: the credit for
 * the returned lines, the replacement total in the cart and what is left to
 * pay or to pay back. The numbers are the domain planner's, so they equal
 * what the server will compute for the same cart.
 */
export function ExchangeBar({
  exchange,
  itemCount,
  disabled,
  onFinish,
  onCancel,
}: {
  exchange: ExchangeHandle;
  itemCount: number;
  disabled: boolean;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("refunds.exchange");
  const format = useFormat();
  const { context, quote, payable } = exchange;
  if (!context) return null;
  const plan = quote?.kind === "ok" ? quote.plan : null;

  return (
    <section
      aria-label={t("title")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-primary/10 px-3 py-2 text-sm"
      data-testid="exchange-bar"
    >
      <span className="flex items-center gap-2 font-semibold">
        <Repeat2 className="size-4" aria-hidden /> {t("title")} · {context.saleNumber}
      </span>
      {exchange.loadFailed ? (
        <>
          <span role="alert" className="text-destructive">
            {t("loadFailed")}
          </span>
          <Button variant="outline" onClick={exchange.retryLoad}>
            {t("retry")}
          </Button>
        </>
      ) : (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("credit")}</dt>
            <dd data-testid="bar-credit">{plan ? format.money(plan.totalAmount) : "—"}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t("replacement")}</dt>
            <dd data-testid="bar-replacement">{format.money(payable)}</dd>
          </div>
          <div className="flex gap-1 font-semibold">
            <dt>
              {plan?.exchange && plan.exchange.netDue === 0n && plan.exchange.netRefund > 0n
                ? t("netRefund")
                : t("netDue")}
            </dt>
            <dd data-testid="bar-net">
              {plan
                ? format.money(
                    plan.exchange
                      ? plan.exchange.netDue > 0n
                        ? plan.exchange.netDue
                        : plan.exchange.netRefund
                      : 0n,
                  )
                : "—"}
            </dd>
          </div>
        </dl>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button
          className="min-h-11"
          disabled={disabled || itemCount === 0 || plan === null}
          onClick={onFinish}
          data-testid="exchange-finish"
        >
          {t("finish")}
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={onCancel}
          data-testid="exchange-cancel"
        >
          {t("cancel")}
        </Button>
      </div>
    </section>
  );
}
