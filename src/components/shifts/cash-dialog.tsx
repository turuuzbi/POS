"use client";

import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { v7 as uuidv7 } from "uuid";
import { KeypadField } from "@/components/pos/keypad";
import { PosDialog } from "@/components/pos/pos-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/domain/money";
import { MAX_REASON_LENGTH } from "@/domain/shift";
import { cashMovementApprovalScope, shiftApprovalKeys } from "@/domain/shift-contract";
import { shiftCodeFromFailure } from "@/domain/shift-failure";
import { parseKeypadMoney } from "@/lib/pos/money-input";
import { requestApproval } from "@/server/actions/auth";
import { cashMovementAction } from "@/server/actions/shifts";
import { cn } from "@/lib/utils";
import { useShiftErrorMessage } from "./use-shift-error";

type MovementType = "CASH_IN" | "CASH_OUT";
type ApprovalKey = (typeof shiftApprovalKeys)[keyof typeof shiftApprovalKeys];

const PIN_MIN = 4;
const PIN_MAX = 8;
const PRESETS = ["float", "drop", "supplier", "change"] as const;

/**
 * Pay-in / pay-out. The server decides what needs a manager: when it answers
 * APPROVAL_REQUIRED / APPROVAL_INVALID for a key, the dialog asks for a PIN,
 * stores the token for that key and sends the request again with the same
 * movement id (idempotent), so a double tap or a retry never books it twice.
 */
export function CashDialog(props: { open: boolean; onClose: () => void }) {
  // Mounted only while open, so every opening starts from a clean form and a new movement id.
  return props.open ? <CashDialogBody {...props} /> : null;
}

function CashDialogBody({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shifts.cash");
  const locale = useLocale();
  const errorMessage = useShiftErrorMessage();
  const [type, setType] = useState<MovementType>("CASH_IN");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [needKey, setNeedKey] = useState<ApprovalKey | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const movementId = useRef(uuidv7());
  const errorId = useId();
  const reasonId = useId();

  const amount = parseKeypadMoney(amountText);
  const valid = amount !== null && amount > 0n && reason.trim().length > 0;

  const submit = async (tokens: Record<string, string>) => {
    if (!valid || busy || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cashMovementAction({
        movementId: movementId.current,
        type,
        amount: amount.toString(),
        reason: reason.trim(),
        approvals: tokens,
        createdAtClient: new Date().toISOString(),
      });
      if (result.ok) {
        toast.success(t("recorded"));
        onClose();
        return;
      }
      const shift = shiftCodeFromFailure(result.error);
      const key = shift?.details?.key;
      if (
        (shift?.code === "APPROVAL_REQUIRED" || shift?.code === "APPROVAL_INVALID") &&
        (key === shiftApprovalKeys.movement || key === shiftApprovalKeys.overdraw)
      ) {
        setApprovals((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        setPin("");
        setNeedKey(key);
        return;
      }
      setError(errorMessage(result.error));
    } catch {
      setError(errorMessage({ code: "INTERNAL" }));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (busy || pin.length < PIN_MIN || needKey === null || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestApproval({
        pin,
        permission: "pos.cash_movement",
        scope: cashMovementApprovalScope(movementId.current, needKey, { type, amount }),
      });
      if (!result.ok) {
        setError(
          result.error.code === "INVALID_CREDENTIALS" || result.error.code === "VALIDATION"
            ? t("invalidPin")
            : errorMessage(result.error),
        );
        setPin("");
        return;
      }
      const next = { ...approvals, [needKey]: result.data.token };
      setApprovals(next);
      setNeedKey(null);
      setPin("");
      setBusy(false);
      await submit(next);
    } catch {
      setError(errorMessage({ code: "INTERNAL" }));
    } finally {
      setBusy(false);
    }
  };

  const amountLabel = amount === null ? "" : formatMoney(amount, { locale });

  return (
    <PosDialog
      open={open}
      onClose={onClose}
      title={needKey ? t("approvalTitle") : t("title")}
      description={needKey ? undefined : t("description")}
      locked={busy}
      className="grid-cols-[minmax(0,1fr)]"
    >
      {needKey ? (
        <div className="space-y-3" data-testid="cash-approval">
          <p className="rounded-md bg-muted px-3 py-2 text-sm" role="status">
            {needKey === shiftApprovalKeys.overdraw
              ? t("approvalOverdraw")
              : t("approvalMovement", {
                  type: type === "CASH_IN" ? t("in") : t("out"),
                  amount: amountLabel,
                })}
          </p>
          <KeypadField
            value={pin}
            onChange={(next) => {
              setError(null);
              setPin(next.slice(0, PIN_MAX));
            }}
            label={t("pin")}
            maxLength={PIN_MAX}
            mask
            leadingZeros
            invalid={error !== null}
            describedBy={error ? errorId : undefined}
            onEnter={approve}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedKey(null)} disabled={busy}>
              {t("back")}
            </Button>
            <Button onClick={approve} disabled={busy || pin.length < PIN_MIN}>
              {busy ? t("checking") : t("approve")}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <div className="space-y-4">
          <div role="radiogroup" aria-label={t("type")} className="grid grid-cols-2 gap-2">
            {(["CASH_IN", "CASH_OUT"] as const).map((option) => {
              const Icon = option === "CASH_IN" ? ArrowDownToLine : ArrowUpFromLine;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={type === option}
                  onClick={() => setType(option)}
                  className={cn(
                    "flex h-14 items-center justify-center gap-2 rounded-lg border text-base font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none",
                    type === option
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent",
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                  {option === "CASH_IN" ? t("in") : t("out")}
                </button>
              );
            })}
          </div>
          <KeypadField
            value={amountText}
            onChange={(next) => {
              setError(null);
              setAmountText(next);
            }}
            label={t("amount")}
            suffix="₮"
            decimals={0}
            invalid={error !== null}
            describedBy={error ? errorId : undefined}
          />
          <div className="space-y-2">
            <label htmlFor={reasonId} className="text-sm font-medium">
              {t("reason")}
            </label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={MAX_REASON_LENGTH}
              placeholder={t("reasonPlaceholder")}
              onChange={(event) => {
                setError(null);
                setReason(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit(approvals);
                }
              }}
            />
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => setReason(t(`presets.${preset}`))}
                >
                  {t(`presets.${preset}`)}
                </Button>
              ))}
            </div>
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t("back")}
            </Button>
            <Button onClick={() => void submit(approvals)} disabled={busy || !valid}>
              {busy ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </div>
      )}
    </PosDialog>
  );
}
