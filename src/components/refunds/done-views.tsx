"use client";

import { CheckCircle2, FileText } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useFormat } from "@/components/pos/use-format";
import { Button } from "@/components/ui/button";
import type { RefundResult } from "@/domain/refund-contract";
import type { VoidResult } from "@/domain/void-contract";
import { cn } from "@/lib/utils";

function CashBack({ amount, testId }: { amount: bigint; testId: string }) {
  const t = useTranslations("refunds.done");
  const format = useFormat();
  return (
    <div
      className={cn(
        "w-full rounded-lg px-3 py-4 text-center",
        amount > 0n ? "bg-success/15" : "bg-muted",
      )}
      role="status"
    >
      <p className="text-sm">{amount > 0n ? t("cashBack") : t("noCash")}</p>
      <p className="text-5xl font-bold tabular-nums" data-testid={testId}>
        {format.money(amount)}
      </p>
    </div>
  );
}

/** After a committed refund: the cash to hand back, where the rest went, the receipt. */
export function RefundDone({
  result,
  onAnother,
  onClose,
}: {
  result: RefundResult;
  onAnother: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("refunds.done");
  const tm = useTranslations("refunds.method");
  const format = useFormat();
  const restocked = result.lines.filter((l) => l.restock).length;
  const rows = result.payments.filter((p) => p.method !== "EXCHANGE_CREDIT");

  return (
    <div className="space-y-4" data-testid="refund-done">
      <div className="flex flex-col items-center gap-2 text-center">
        <CheckCircle2 className="size-12 text-success" aria-hidden />
        <h3 className="text-xl font-semibold">
          {result.exchange ? t("exchangeTitle") : t("title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("receiptNumber", { number: result.receiptNumber })}
        </p>
        <p className="text-sm">{t("refunded")}</p>
        <p className="text-3xl font-bold tabular-nums" data-testid="done-total">
          {format.money(result.totals.totalAmount)}
        </p>
      </div>

      <CashBack amount={result.cashRefund} testId="done-cash" />

      {rows.length > 0 ? (
        <ul className="space-y-1 text-sm" aria-label={t("payouts")}>
          {rows.map((row, index) => (
            <li key={`${row.method}-${index}`} className="flex justify-between gap-2">
              <span>{tm(row.method)}</span>
              <span className="tabular-nums">{format.money(row.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.exchange ? (
        <dl className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm">
          <div className="flex justify-between gap-2">
            <dt>{t("creditApplied")}</dt>
            <dd className="tabular-nums">{format.money(result.exchange.creditApplied)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{t("netDue")}</dt>
            <dd className="tabular-nums">{format.money(result.exchange.netDue)}</dd>
          </div>
        </dl>
      ) : null}
      {restocked > 0 ? (
        <p className="text-sm text-muted-foreground">{t("restocked", { count: restocked })}</p>
      ) : null}
      {result.completesSale ? (
        <p className="text-sm text-muted-foreground">{t("completesSale")}</p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3">
        <Button variant="outline" size="lg" asChild>
          <Link
            href={`/receipt/refund/${result.refundId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileText aria-hidden /> {t("receipt")}
          </Link>
        </Button>
        <Button variant="outline" size="lg" onClick={onAnother}>
          {t("another")}
        </Button>
        <Button size="lg" autoFocus onClick={onClose}>
          {t("done")}
        </Button>
      </div>
    </div>
  );
}

/** After a committed void. */
export function VoidDone({
  result,
  onAnother,
  onClose,
}: {
  result: VoidResult;
  onAnother: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("refunds.voidDone");
  const td = useTranslations("refunds.done");
  const format = useFormat();
  return (
    <div className="space-y-4" data-testid="void-done">
      <div className="flex flex-col items-center gap-2 text-center">
        <CheckCircle2 className="size-12 text-success" aria-hidden />
        <h3 className="text-xl font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("receiptNumber", { number: result.receiptNumber })}
        </p>
        <p className="text-3xl font-bold tabular-nums" data-testid="void-done-total">
          {format.money(result.totalAmount)}
        </p>
      </div>
      <CashBack amount={result.cashReturned} testId="void-done-cash" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="outline" size="lg" onClick={onAnother}>
          {td("another")}
        </Button>
        <Button size="lg" autoFocus onClick={onClose}>
          {td("done")}
        </Button>
      </div>
    </div>
  );
}
