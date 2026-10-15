"use client";

import { Banknote, CreditCard, Landmark, QrCode, Repeat2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormat } from "@/components/pos/use-format";
import type { PaymentMethod, RefundPlan } from "@/domain/refund";
import { payoutRows } from "@/lib/refunds/plan";
import { cn } from "@/lib/utils";

const ICONS: Partial<Record<PaymentMethod, typeof Banknote>> = {
  CASH: Banknote,
  CARD: CreditCard,
  BANK_TRANSFER: Landmark,
  QPAY: QrCode,
  EXCHANGE_CREDIT: Repeat2,
};

function Row({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId?: string;
  strong?: boolean;
}) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "font-semibold")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * What the customer gets back, from the client's `planRefund` run: items, tax
 * split, tip and rounding, the total, and which tender pays it out. With a
 * `plan` of null it renders the same skeleton with dashes, so choosing lines
 * never shifts the layout.
 */
export function RefundSummary({
  plan,
  replacementTotal,
}: {
  plan: RefundPlan | null;
  /** Exchange: payable of the replacement items (shown with credit / net due). */
  replacementTotal?: bigint;
}) {
  const t = useTranslations("refunds.summary");
  const tm = useTranslations("refunds.method");
  const format = useFormat();
  const money = (value: bigint | undefined) => (value === undefined ? "—" : format.money(value));
  const rows = plan ? payoutRows(plan) : [];
  const exchange = plan?.exchange ?? null;

  return (
    <div className="space-y-3" data-testid="refund-summary">
      <dl className="space-y-1 text-sm">
        <Row label={t("items")} value={money(plan?.itemsTotal)} testId="refund-items" />
        <Row label={t("net")} value={money(plan?.netAmount)} testId="refund-net" />
        <Row label={t("vat")} value={money(plan?.vatAmount)} testId="refund-vat" />
        {plan && plan.cityTaxAmount > 0n ? (
          <Row label={t("cityTax")} value={money(plan.cityTaxAmount)} testId="refund-city" />
        ) : null}
        {plan && plan.tipAmount > 0n ? (
          <Row label={t("tip")} value={money(plan.tipAmount)} testId="refund-tip" />
        ) : null}
        {plan && plan.roundingAmount !== 0n ? (
          <Row label={t("rounding")} value={money(plan.roundingAmount)} testId="refund-rounding" />
        ) : null}
      </dl>
      <div className="flex items-baseline justify-between gap-3 border-t pt-2">
        <span className="text-base font-semibold">{t("total")}</span>
        <span className="text-3xl font-bold tabular-nums" data-testid="refund-total">
          {money(plan?.totalAmount)}
        </span>
      </div>

      {exchange ? (
        <dl className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm" data-testid="exchange-math">
          <Row
            label={t("replacement")}
            value={money(replacementTotal ?? exchange.newSaleTotal)}
            testId="exchange-replacement"
          />
          <Row label={t("credit")} value={money(exchange.creditApplied)} testId="exchange-credit" />
          {exchange.netDue > 0n ? (
            <Row
              label={t("netDue")}
              value={money(exchange.netDue)}
              testId="exchange-net-due"
              strong
            />
          ) : (
            <Row
              label={t("netRefund")}
              value={money(exchange.netRefund)}
              testId="exchange-net-refund"
              strong
            />
          )}
        </dl>
      ) : null}

      <div className="space-y-1">
        <p className="text-sm font-medium">{t("payout")}</p>
        {rows.length > 0 ? (
          <ul className="space-y-1 text-sm" data-testid="refund-payout">
            {rows.map((row) => {
              const Icon = ICONS[row.method];
              return (
                <li key={row.method} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : null}
                    {tm(row.method)}
                  </span>
                  <span className="tabular-nums" data-testid={`payout-${row.method}`}>
                    {format.money(row.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="refund-payout">
            {plan ? t("noPayout") : "—"}
          </p>
        )}
      </div>

      {plan && plan.cashRefund > 0n ? (
        <div className="rounded-lg bg-success/15 px-3 py-3" role="status">
          <p className="text-sm">{t("cashBack")}</p>
          <p className="text-4xl font-bold tabular-nums" data-testid="refund-cash">
            {format.money(plan.cashRefund)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
