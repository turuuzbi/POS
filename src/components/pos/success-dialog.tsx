"use client";

import { CheckCircle2, FileText } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/hooks/use-action";
import type { CheckoutResult } from "@/domain/checkout-contract";
import { sendReceiptAction } from "@/server/actions/receipts";
import { PosDialog } from "./pos-dialog";
import { useFormat } from "./use-format";

/** Shown after a committed sale: change due, receipt, optional delivery contact. */
export function SuccessDialog({
  result,
  onNewSale,
}: {
  result: CheckoutResult;
  onNewSale: () => void;
}) {
  const t = useTranslations("pos.success");
  const tm = useTranslations("pos.tender.method");
  const format = useFormat();
  const emailId = useId();
  const phoneId = useId();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const receiptHref = `/receipt/${result.saleId}`;
  const { run, pending, errorMessage } = useAction(sendReceiptAction);

  const send = (channel: "EMAIL" | "SMS", destination: string) => {
    const to = destination.trim();
    if (!to || pending) return;
    run(
      { saleId: result.saleId, channel, destination: to },
      {
        onSuccess: (sent) =>
          sent.status === "SENT"
            ? toast.success(t("sentTo", { destination: to }))
            : toast.error(t("sendFailed")),
      },
    );
  };

  return (
    <PosDialog
      open
      onClose={onNewSale}
      title={t("title")}
      description={t("receiptNumber", { number: result.receiptNumber })}
      locked
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <CheckCircle2 className="size-12 text-success" aria-hidden />
        <p className="text-sm text-muted-foreground">{t("paid")}</p>
        <p className="text-3xl font-bold tabular-nums" data-testid="success-total">
          {format.money(result.totals.payable)}
        </p>
        {result.change > 0n ? (
          <div className="mt-2 w-full rounded-lg bg-success/15 px-3 py-3" role="status">
            <p className="text-sm">{t("changeDue")}</p>
            <p className="text-5xl font-bold tabular-nums" data-testid="success-change">
              {format.money(result.change)}
            </p>
          </div>
        ) : null}
        {result.status === "COMPLETED_NEEDS_REVIEW" ? (
          <p className="text-sm text-muted-foreground">{t("needsReview")}</p>
        ) : null}
      </div>

      <ul className="space-y-1 text-sm">
        {result.payments.map((payment, index) => (
          <li key={index} className="flex justify-between gap-2">
            <span>
              {tm(payment.method as "CASH" | "CARD" | "BANK_TRANSFER" | "QPAY")}
              {payment.reference ? ` · ${payment.reference}` : ""}
            </span>
            <span className="tabular-nums">{format.money(payment.amount)}</span>
          </li>
        ))}
      </ul>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={emailId}>{t("email")}</Label>
          <div className="flex gap-2">
            <Input
              id={emailId}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending || !email.trim()}
              aria-label={`${t("send")}: ${t("email")}`}
              onClick={() => send("EMAIL", email)}
            >
              {t("send")}
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={phoneId}>{t("phone")}</Label>
          <div className="flex gap-2">
            <Input
              id={phoneId}
              type="tel"
              autoComplete="off"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending || !phone.trim()}
              aria-label={`${t("send")}: ${t("phone")}`}
              onClick={() => send("SMS", phone)}
            >
              {t("send")}
            </Button>
          </div>
        </div>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="outline" size="lg" asChild>
          <Link href={receiptHref} target="_blank" rel="noopener noreferrer">
            <FileText aria-hidden /> {t("receipt")}
          </Link>
        </Button>
        <Button size="lg" autoFocus onClick={onNewSale}>
          {t("newSale")}
        </Button>
      </div>
    </PosDialog>
  );
}
