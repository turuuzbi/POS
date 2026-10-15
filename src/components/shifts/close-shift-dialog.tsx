"use client";

import { LogOut, Minus, Plus, TriangleAlert } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { PosDialog } from "@/components/pos/pos-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/domain/money";
import {
  denominationsTotal,
  MAX_CLOSING_NOTE_LENGTH,
  MAX_DENOMINATION_COUNT,
  MNT_DENOMINATIONS,
} from "@/domain/shift";
import { closeShiftResultSchema, type CloseShiftResult } from "@/domain/shift-contract";
import { shiftCodeFromFailure } from "@/domain/shift-failure";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { logout } from "@/server/actions/auth";
import { closeShiftAction } from "@/server/actions/shifts";
import type { ShiftDetail } from "@/server/queries/shifts";
import { PrintableReport } from "./report-view";
import { useShiftErrorMessage } from "./use-shift-error";
import { useShiftReport } from "./x-report-dialog";

type Step = "count" | "confirm" | "result";

const emptyCounts = () => Object.fromEntries(MNT_DENOMINATIONS.map((d) => [String(d), 0]));

/**
 * Blind close: count by note and coin first; the expected amount and the
 * variance appear only after the shift is closed. Then the Z report with Print
 * and Sign out.
 */
export function CloseShiftDialog(props: CloseShiftDialogProps) {
  // Mounted only while open: every opening starts from a clean count.
  return props.open ? <CloseShiftBody {...props} /> : null;
}

interface CloseShiftDialogProps {
  open: boolean;
  /** Closing the dialog before the shift is closed. */
  onClose: () => void;
  shiftId: string;
  heldCount: number;
  cartCount: number;
  /** A charge / payment is in flight: closing is blocked. */
  charging: boolean;
  /** After the shift is closed and the cashier is done (refresh the register). */
  onFinished: () => void;
}

function CloseShiftBody({
  open,
  onClose,
  shiftId,
  heldCount,
  cartCount,
  charging,
  onFinished,
}: CloseShiftDialogProps) {
  const t = useTranslations("shifts.close");
  const tr = useTranslations("shifts.report");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useShiftErrorMessage();
  const [counts, setCounts] = useState<Record<string, number>>(emptyCounts);
  const [note, setNote] = useState("");
  const [step, setStep] = useState<Step>("count");
  const [noteRequired, setNoteRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseShiftResult | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const signOut = useAction(logout);
  const { detail } = useShiftReport(shiftId, step === "result");

  const total = denominationsTotal(counts);
  const money = (amount: bigint) => formatMoney(amount, { locale });

  const setCount = (denomination: number, value: number) => {
    const clamped = Math.min(MAX_DENOMINATION_COUNT, Math.max(0, Math.trunc(value) || 0));
    setCounts((current) => ({ ...current, [String(denomination)]: clamped }));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await closeShiftAction({
        shiftId,
        denominations: counts,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (response.ok) {
        const parsed = closeShiftResultSchema.safeParse(response.data);
        if (parsed.success) {
          setResult(parsed.data);
          setStep("result");
        } else {
          setError(errorMessage({ code: "INTERNAL" }));
          setStep("count");
        }
        return;
      }
      setError(errorMessage(response.error));
      setStep("count");
      if (shiftCodeFromFailure(response.error)?.code === "VARIANCE_NOTE_REQUIRED") {
        setNoteRequired(true);
        requestAnimationFrame(() => noteRef.current?.focus());
      }
    } catch {
      setError(errorMessage({ code: "INTERNAL" }));
      setStep("count");
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    onFinished();
    onClose();
  };

  const blocked = charging;
  const closed = step === "result";

  return (
    <PosDialog
      open={open}
      onClose={closed ? done : onClose}
      title={closed ? t("resultTitle") : t("title")}
      description={closed ? undefined : t("description")}
      locked={busy}
      className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl"
    >
      {step === "count" ? (
        <div className="space-y-4" data-testid="close-count">
          {blocked ? (
            <p role="alert" className="flex gap-2 rounded-md bg-warning/25 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("blockedCharge")}
            </p>
          ) : null}
          {heldCount > 0 ? (
            <p role="status" className="flex gap-2 rounded-md bg-warning/25 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("warnHeld", { count: heldCount })}
            </p>
          ) : null}
          {cartCount > 0 ? (
            <p role="status" className="flex gap-2 rounded-md bg-warning/25 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("warnCart", { count: cartCount })}
            </p>
          ) : null}

          <fieldset className="space-y-1">
            <legend className="mb-2 text-sm font-medium">{t("countHeading")}</legend>
            <ul className="divide-y rounded-lg border">
              {MNT_DENOMINATIONS.map((denomination) => {
                const count = counts[String(denomination)] ?? 0;
                const valueText = format.number(denomination);
                return (
                  <li
                    key={denomination}
                    className="flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3"
                    data-testid={`denomination-${denomination}`}
                  >
                    <span className="w-20 shrink-0 font-medium tabular-nums sm:w-24">
                      {t("denominationLabel", { value: valueText })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-12"
                      aria-label={t("decrease", { value: valueText })}
                      disabled={count <= 0}
                      onClick={() => setCount(denomination, count - 1)}
                    >
                      <Minus aria-hidden />
                    </Button>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      aria-label={t("count", { value: valueText })}
                      value={String(count)}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) =>
                        setCount(denomination, Number(event.target.value.replace(/\D/g, "")))
                      }
                      className="h-12 w-16 rounded-md border border-input-border bg-background text-center text-xl font-semibold tabular-nums focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:w-20"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-12"
                      aria-label={t("increase", { value: valueText })}
                      onClick={() => setCount(denomination, count + 1)}
                    >
                      <Plus aria-hidden />
                    </Button>
                    <span className="ml-auto hidden min-w-0 text-right text-sm text-muted-foreground tabular-nums sm:block">
                      {money(BigInt(denomination) * 100n * BigInt(count))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <div
            className="flex items-baseline justify-between rounded-lg bg-muted px-4 py-3"
            aria-live="polite"
          >
            <span className="font-medium">{t("counted")}</span>
            <span className="text-2xl font-semibold tabular-nums" data-testid="counted-total">
              {money(total)}
            </span>
          </div>

          <div className="space-y-2">
            <label htmlFor={noteId} className="text-sm font-medium">
              {t("note")}
            </label>
            <Textarea
              id={noteId}
              ref={noteRef}
              value={note}
              maxLength={MAX_CLOSING_NOTE_LENGTH}
              aria-invalid={noteRequired && note.trim() === "" ? true : undefined}
              aria-describedby={noteRequired ? errorId : undefined}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("noteHint")}</p>
          </div>

          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              disabled={blocked}
              onClick={() => {
                setError(null);
                setStep("confirm");
              }}
            >
              {t("review")}
            </Button>
          </DialogFooter>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="space-y-4" data-testid="close-confirm">
          <h3 className="text-lg font-semibold">{t("confirmTitle")}</h3>
          <p>{t("confirmBody", { counted: money(total) })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStep("count")} disabled={busy}>
              {t("back")}
            </Button>
            <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
              {busy ? t("closing") : t("confirm")}
            </Button>
          </DialogFooter>
        </div>
      ) : null}

      {step === "result" && result ? (
        <div className="space-y-4" data-testid="close-result">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <ResultCell label={t("resultExpected")} value={money(result.expectedCash)} />
            <ResultCell label={t("resultCounted")} value={money(result.countedCash)} />
            <ResultCell
              label={t("resultVariance")}
              value={money(result.cashVariance)}
              tone={result.classification}
              testId="result-variance"
            />
          </dl>
          <p className="text-sm text-muted-foreground">
            {t("resultZ", { number: result.zReportNumber })} ·{" "}
            <span data-testid="result-class">{tr(`classification.${result.classification}`)}</span>
          </p>
          {detail ? <ClosedReport detail={detail} /> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => signOut.run({}, { toastOnError: true })}
              disabled={signOut.pending}
            >
              <LogOut aria-hidden />
              {t("signOut")}
            </Button>
            <Button onClick={done}>{t("done")}</Button>
          </DialogFooter>
        </div>
      ) : null}
    </PosDialog>
  );
}

function ClosedReport({ detail }: { detail: ShiftDetail }) {
  return (
    <div data-testid="z-report">
      <PrintableReport
        report={detail.report}
        meta={{
          registerName: detail.shift.registerName,
          locationName: detail.shift.locationName,
          openedByName: detail.shift.openedByName,
          closedByName: detail.shift.closedByName,
          zNumber: detail.shift.zReportNumber,
        }}
        movements={detail.movements}
      />
    </div>
  );
}

function ResultCell({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string;
  tone?: "OK" | "SHORT" | "OVER";
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-3",
        tone === "SHORT" && "border-destructive/50 bg-destructive/10",
        tone === "OVER" && "border-warning bg-warning/20",
        tone === "OK" && "border-success/50 bg-success/10",
      )}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
