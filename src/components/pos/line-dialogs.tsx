"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_NOTE_LENGTH } from "@/domain/cart";
import { discountNeedsApproval, type DiscountRequest } from "@/domain/discounts";
import { MINOR_PER_MAJOR, type Money } from "@/domain/money";
import { isFractionalUnit, parseQty, type Unit } from "@/domain/qty";
import { moneyToInput, parseKeypadMoney, parsePercentBps, qtyToInput } from "@/lib/pos/money-input";
import { cn } from "@/lib/utils";
import { KeypadField } from "./keypad";
import { PosDialog } from "./pos-dialog";
import { useFormat } from "./use-format";

// --- Quantity ----------------------------------------------------------------------

export function QtyDialog({
  open,
  onClose,
  title,
  unit,
  qtyMilli,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  unit: Unit;
  qtyMilli: number | null;
  onSubmit: (qtyMilli: number) => void;
}) {
  const t = useTranslations("pos.qty");
  const format = useFormat();
  const fractional = isFractionalUnit(unit);
  const [text, setText] = useState(qtyMilli ? qtyToInput(qtyMilli) : "");
  const parsed = text ? parseQty(text, unit) : null;
  const invalid = text !== "" && parsed === null;
  const errorId = useId();
  const submit = () => {
    if (parsed !== null) onSubmit(parsed);
  };
  return (
    <PosDialog open={open} onClose={onClose} title={title} description={t("description")}>
      <KeypadField
        value={text}
        onChange={setText}
        label={fractional ? t("labelWeighed", { unit: format.unit(unit) }) : t("labelPieces")}
        suffix={format.unit(unit)}
        decimals={fractional ? 3 : 0}
        invalid={invalid}
        describedBy={invalid ? errorId : undefined}
        onEnter={submit}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {fractional ? t("invalidWeighed") : t("invalidPieces")}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button onClick={submit} disabled={parsed === null}>
          {t("apply")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}

// --- Price override ----------------------------------------------------------------

export function PriceDialog({
  open,
  onClose,
  title,
  listedPrice,
  currentOverride,
  onSubmit,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  listedPrice: Money;
  currentOverride: Money | undefined;
  onSubmit: (price: Money) => void;
  onReset: () => void;
}) {
  const t = useTranslations("pos.price");
  const format = useFormat();
  const decimals = listedPrice % MINOR_PER_MAJOR !== 0n ? 2 : 0;
  const [text, setText] = useState(
    currentOverride !== undefined ? moneyToInput(currentOverride) : "",
  );
  const parsed = parseKeypadMoney(text);
  const submit = () => {
    if (parsed !== null) onSubmit(parsed);
  };
  return (
    <PosDialog
      open={open}
      onClose={onClose}
      title={title}
      description={t("description", { price: format.money(listedPrice) })}
    >
      <KeypadField
        value={text}
        onChange={setText}
        label={t("label")}
        suffix="₮"
        decimals={decimals}
        onEnter={submit}
      />
      <p className="text-sm text-muted-foreground">{t("approvalHint")}</p>
      <DialogFooter>
        {currentOverride !== undefined ? (
          <Button variant="outline" onClick={onReset}>
            {t("reset")}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button onClick={submit} disabled={parsed === null}>
          {t("apply")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}

// --- Discount ------------------------------------------------------------------------

export function DiscountDialog({
  open,
  onClose,
  title,
  base,
  hasExisting,
  canSkipApproval,
  maxBpsWithoutApproval,
  onApply,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the discount applies to (line amount / cart pool), for the approval hint. */
  base: Money;
  hasExisting: boolean;
  /** The signed-in user may discount freely (manager / owner). */
  canSkipApproval: boolean;
  maxBpsWithoutApproval: number;
  onApply: (request: DiscountRequest) => void;
  onClear: () => void;
}) {
  const t = useTranslations("pos.discount");
  const [kind, setKind] = useState<"PERCENT" | "FIXED">("PERCENT");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const reasonId = useId();

  let request: DiscountRequest | null = null;
  if (kind === "PERCENT") {
    const bps = parsePercentBps(text);
    if (bps !== null) request = { kind, percentBps: bps };
  } else {
    const amount = parseKeypadMoney(text);
    if (amount !== null && amount > 0n && amount <= base) request = { kind, amount };
  }
  if (request && reason.trim()) request = { ...request, reason: reason.trim().slice(0, 120) };
  const needsApproval =
    !canSkipApproval &&
    request !== null &&
    discountNeedsApproval(request, base, { maxDiscountBpsWithoutApproval: maxBpsWithoutApproval });
  const invalid = text !== "" && request === null;

  return (
    <PosDialog open={open} onClose={onClose} title={title} description={t("description")}>
      <div role="radiogroup" aria-label={t("kind")} className="grid grid-cols-2 gap-2">
        {(["PERCENT", "FIXED"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            variant={kind === value ? "default" : "outline"}
            onClick={() => {
              setKind(value);
              setText("");
            }}
          >
            {value === "PERCENT" ? t("percent") : t("fixed")}
          </Button>
        ))}
      </div>
      <KeypadField
        key={kind}
        value={text}
        onChange={setText}
        label={kind === "PERCENT" ? t("percentLabel") : t("fixedLabel")}
        suffix={kind === "PERCENT" ? "%" : "₮"}
        decimals={kind === "PERCENT" ? 2 : 0}
        maxLength={kind === "PERCENT" ? 6 : 12}
        invalid={invalid}
        onEnter={() => request && onApply(request)}
      />
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {kind === "PERCENT" ? t("invalidPercent") : t("invalidFixed")}
        </p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={reasonId}>{t("reason")}</Label>
        <Input
          id={reasonId}
          value={reason}
          maxLength={120}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {needsApproval ? (
        <p className="rounded-md bg-warning/20 px-3 py-2 text-sm" role="status">
          {t("needsApproval", { percent: maxBpsWithoutApproval / 100 })}
        </p>
      ) : null}
      <DialogFooter>
        {hasExisting ? (
          <Button variant="outline" onClick={onClear}>
            {t("clear")}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button onClick={() => request && onApply(request)} disabled={request === null}>
          {t("apply")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}

// --- Note ------------------------------------------------------------------------------

export function NoteDialog({
  open,
  onClose,
  title,
  note,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  note: string;
  onSubmit: (note: string | null) => void;
}) {
  const t = useTranslations("pos.note");
  const [text, setText] = useState(note);
  const id = useId();
  return (
    <PosDialog open={open} onClose={onClose} title={title}>
      <form
        className={cn("space-y-4")}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(text.trim() || null);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor={id}>{t("label")}</Label>
          <Input
            id={id}
            autoFocus
            value={text}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit">{t("save")}</Button>
        </DialogFooter>
      </form>
    </PosDialog>
  );
}
