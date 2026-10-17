"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useFormat } from "@/components/pos/use-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Money } from "@/domain/money";
import { sum } from "@/domain/money";
import { moneyToInput, parseKeypadMoney } from "@/lib/pos/money-input";
import { PAYOUT_METHODS, type PayoutChoice, type PayoutMethod } from "@/lib/refunds/plan";
import { cn } from "@/lib/utils";

type Kind = "ORIGINAL" | "CASH" | "BANK_TRANSFER" | "CUSTOM";

function kindOf(choice: PayoutChoice): Kind {
  if (choice.kind === "METHOD") return choice.method === "CASH" ? "CASH" : "BANK_TRANSFER";
  return choice.kind;
}

/** The per-method text boxes for a choice (a remount must not blank a stored split). */
export function initialPayoutText(choice: PayoutChoice): Record<PayoutMethod, string> {
  const text: Record<PayoutMethod, string> = { CASH: "", CARD: "", QPAY: "", BANK_TRANSFER: "" };
  if (choice.kind === "CUSTOM") {
    for (const entry of choice.entries) text[entry.method] = moneyToInput(entry.amount);
  }
  return text;
}

/**
 * Where the refund goes. The default is the original tenders (proportional,
 * no approval). A manager may send it all to cash or bank transfer, or split
 * it by hand; paying out through a tender the customer did not use needs the
 * manager's PIN (the approval list on the Returns screen says so).
 */
export function PayoutEditor({
  choice,
  onChange,
  netRefund,
  disabled,
}: {
  choice: PayoutChoice;
  onChange: (choice: PayoutChoice) => void;
  /** What has to be paid out (total, less any exchange credit). */
  netRefund: Money;
  disabled: boolean;
}) {
  const t = useTranslations("refunds.payout");
  const tm = useTranslations("refunds.method");
  const format = useFormat();
  const [text, setText] = useState<Record<PayoutMethod, string>>(() => initialPayoutText(choice));
  const groupId = useId();
  const kind = kindOf(choice);

  const entriesOf = (next: Record<PayoutMethod, string>) =>
    PAYOUT_METHODS.flatMap((method) => {
      const amount = parseKeypadMoney(next[method]);
      return amount !== null && amount > 0n ? [{ method, amount }] : [];
    });
  const allocated = choice.kind === "CUSTOM" ? sum(choice.entries.map((e) => e.amount)) : 0n;

  const options: { kind: Kind; label: string; apply: () => void }[] = [
    { kind: "ORIGINAL", label: t("original"), apply: () => onChange({ kind: "ORIGINAL" }) },
    {
      kind: "CASH",
      label: t("allCash"),
      apply: () => onChange({ kind: "METHOD", method: "CASH" }),
    },
    {
      kind: "BANK_TRANSFER",
      label: t("allBank"),
      apply: () => onChange({ kind: "METHOD", method: "BANK_TRANSFER" }),
    },
    {
      kind: "CUSTOM",
      label: t("custom"),
      apply: () => {
        const next = { ...text };
        onChange({ kind: "CUSTOM", entries: entriesOf(next) });
      },
    },
  ];

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{t("title")}</legend>
      <div role="radiogroup" aria-label={t("title")} className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <Button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={kind === option.kind}
            variant={kind === option.kind ? "default" : "outline"}
            className="h-auto min-h-11 whitespace-normal"
            onClick={option.apply}
            data-testid={`payout-choice-${option.kind}`}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {kind !== "ORIGINAL" ? (
        <p className="text-sm text-muted-foreground">{t("managerNote")}</p>
      ) : null}
      {choice.kind === "CUSTOM" ? (
        <div className="space-y-2" id={groupId}>
          {PAYOUT_METHODS.map((method) => (
            <div key={method} className="grid grid-cols-[7rem_1fr] items-center gap-2">
              <Label htmlFor={`${groupId}-${method}`}>{tm(method)}</Label>
              <Input
                id={`${groupId}-${method}`}
                inputMode="decimal"
                autoComplete="off"
                className="text-right tabular-nums"
                value={text[method]}
                placeholder={moneyToInput(0n)}
                onChange={(event) => {
                  const next = { ...text, [method]: event.target.value.replace(/[^\d.,]/g, "") };
                  setText(next);
                  onChange({ kind: "CUSTOM", entries: entriesOf(next) });
                }}
              />
            </div>
          ))}
          <p
            className={cn(
              "text-sm tabular-nums",
              allocated === netRefund ? "text-muted-foreground" : "text-destructive",
            )}
            role="status"
          >
            {t("allocated", {
              allocated: format.money(allocated),
              total: format.money(netRefund),
            })}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
