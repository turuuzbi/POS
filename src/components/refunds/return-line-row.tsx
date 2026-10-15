"use client";

import { Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { KeypadField } from "@/components/pos/keypad";
import { PosDialog } from "@/components/pos/pos-dialog";
import { useFormat } from "@/components/pos/use-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { isFractionalUnit } from "@/domain/qty";
import type { LineProgress } from "@/domain/refund";
import { lineState, parseTypedQty, type LineChoice } from "@/lib/refunds/plan";
import type { ReturnSaleLine } from "@/lib/refunds/sale-wire";
import { cn } from "@/lib/utils";

/** Decimal keypad for a weighed / measured line: how much is coming back. */
function ReturnQtyDialog({
  line,
  progress,
  current,
  onClose,
  onSubmit,
}: {
  line: ReturnSaleLine;
  progress: LineProgress;
  current: number;
  onClose: () => void;
  onSubmit: (qtyMilli: number) => void;
}) {
  const t = useTranslations("refunds.qty");
  const format = useFormat();
  const [text, setText] = useState(current > 0 ? String(current / 1000) : "");
  const errorId = useId();
  const parsed = text === "" ? null : parseTypedQty(text, line, progress.remainingQtyMilli);
  const invalid = text !== "" && parsed === null;
  const submit = () => {
    if (parsed !== null) onSubmit(parsed);
  };
  return (
    <PosDialog
      open
      onClose={onClose}
      title={line.name}
      description={t("description", {
        max: `${format.qty(progress.remainingQtyMilli, line.unit)} ${format.unit(line.unit)}`,
      })}
    >
      <KeypadField
        value={text}
        onChange={setText}
        label={t("label", { unit: format.unit(line.unit) })}
        decimals={3}
        maxLength={10}
        invalid={invalid}
        describedBy={invalid ? errorId : undefined}
        onEnter={submit}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t("invalid", {
            max: `${format.qty(progress.remainingQtyMilli, line.unit)} ${format.unit(line.unit)}`,
          })}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        {current > 0 ? (
          <Button variant="outline" onClick={() => onSubmit(0)}>
            {t("clear")}
          </Button>
        ) : null}
        <Button onClick={submit} disabled={parsed === null}>
          {t("apply")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}

/**
 * One sold line: how much is left to return, a +/- stepper (weighed goods open
 * a decimal keypad), an "all" shortcut and the restock switch. The switch
 * defaults from the product's stock tracking; untracked items cannot restock.
 */
export function ReturnLineRow({
  line,
  progress,
  choice,
  disabled,
  onStep,
  onAll,
  onSetQty,
  onRestock,
}: {
  line: ReturnSaleLine;
  progress: LineProgress;
  choice: LineChoice | undefined;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
  onAll: () => void;
  onSetQty: (qtyMilli: number) => void;
  onRestock: (restock: boolean) => void;
}) {
  const t = useTranslations("refunds.line");
  const format = useFormat();
  const [typing, setTyping] = useState(false);
  const restockId = useId();
  const state = lineState(line, progress);
  const fractional = isFractionalUnit(line.unit);
  const qty = choice?.qtyMilli ?? 0;
  const blocked = state === "DONE" || state === "GIFT_CARD";
  const unit = format.unit(line.unit);
  const qtyText = (milli: number) => `${format.qty(milli, line.unit)} ${unit}`;

  return (
    <li
      data-testid="return-line"
      data-selected={qty > 0 ? "true" : undefined}
      className={cn(
        "space-y-3 rounded-lg border bg-background p-3",
        qty > 0 && "border-primary ring-1 ring-primary/30",
        blocked && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{line.name}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {qtyText(line.qtyMilli)} × {format.money(line.unitPrice)}
            {line.sku ? ` · ${line.sku}` : ""}
          </p>
        </div>
        <p className="shrink-0 font-semibold tabular-nums">{format.money(line.totalAmount)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {state === "GIFT_CARD" ? (
          <Badge variant="outline">{t("giftCard")}</Badge>
        ) : state === "DONE" ? (
          <Badge variant="secondary">{t("allReturned")}</Badge>
        ) : (
          <>
            <span className="text-muted-foreground" data-testid="line-remaining">
              {t("remaining", { qty: qtyText(progress.remainingQtyMilli) })}
            </span>
            {state === "PARTIAL" ? (
              <Badge variant="secondary">
                {t("alreadyReturned", { qty: qtyText(progress.refundedQtyMilli) })}
              </Badge>
            ) : null}
          </>
        )}
      </div>

      {!blocked ? (
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label={t("quantityOf", { name: line.name })}
            className="flex items-center gap-1"
          >
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("decrease", { name: line.name })}
              disabled={disabled || qty === 0}
              onClick={() => onStep(-1)}
            >
              <Minus aria-hidden />
            </Button>
            {fractional ? (
              <Button
                type="button"
                variant="outline"
                className="min-w-24 tabular-nums"
                aria-label={t("editQty", { name: line.name })}
                disabled={disabled}
                onClick={() => setTyping(true)}
                data-testid="line-qty"
              >
                {qtyText(qty)}
              </Button>
            ) : (
              <output
                className="inline-flex h-11 min-w-14 items-center justify-center rounded-md border px-3 text-base font-semibold tabular-nums"
                aria-live="polite"
                data-testid="line-qty"
              >
                {format.qty(qty, line.unit)}
              </output>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("increase", { name: line.name })}
              disabled={disabled || qty >= progress.remainingQtyMilli}
              onClick={() => onStep(1)}
            >
              <Plus aria-hidden />
            </Button>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || qty === progress.remainingQtyMilli}
            onClick={onAll}
            aria-label={t("returnAll", { name: line.name })}
          >
            {t("all")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {line.tracksStock ? (
              <>
                <label htmlFor={restockId} className="text-sm">
                  {t("restock")}
                </label>
                <Switch
                  id={restockId}
                  checked={choice?.restock ?? true}
                  disabled={disabled || qty === 0}
                  onCheckedChange={onRestock}
                />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">{t("noStock")}</span>
            )}
          </div>
        </div>
      ) : null}

      {typing ? (
        <ReturnQtyDialog
          line={line}
          progress={progress}
          current={qty}
          onClose={() => setTyping(false)}
          onSubmit={(next) => {
            setTyping(false);
            onSetQty(next);
          }}
        />
      ) : null}
    </li>
  );
}
