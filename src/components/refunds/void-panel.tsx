"use client";

import { ArrowLeft, Ban } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApprovalPinDialog } from "@/components/refunds/approval-pin-dialog";
import { SaleHeader } from "@/components/refunds/sale-header";
import { useFailureMessage } from "@/components/refunds/use-failure-message";
import { useFormat } from "@/components/pos/use-format";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { hasPermission, type Role } from "@/domain/permissions";
import { VOID_REASONS, type VoidReason } from "@/domain/void";
import { voidInputSchema, type VoidResult } from "@/domain/void-contract";
import { useOnline } from "@/hooks/use-online";
import { isApprovalProblem, isStale, type FailureView } from "@/lib/refunds/errors";
import type { ReturnSale } from "@/lib/refunds/sale-wire";
import { submitVoid } from "@/lib/refunds/submit";
import { buildVoidInput, checkVoid, VOID_BLOCK_KEY, type VoidInputWire } from "@/lib/refunds/void";
import { voidSaleAction } from "@/server/actions/voids";

type Submit = { kind: "idle" } | { kind: "sending" } | { kind: "unknown"; input: VoidInputWire };

/**
 * Void one sale of the open shift: reason (+ note), the manager's PIN where the
 * cashier lacks `pos.void`, and the same `planVoid` the server runs to say
 * what will be reversed, or exactly why the sale cannot be voided.
 */
export function VoidPanel({
  sale,
  role,
  currentShiftId,
  onBack,
  onDone,
  onReload,
  onBusy,
}: {
  sale: ReturnSale;
  role: Role;
  currentShiftId: string | null;
  onBack: () => void;
  onDone: (result: VoidResult) => void;
  onReload: (checkVoided: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const t = useTranslations("refunds");
  const tm = useTranslations("refunds.method");
  const tb = useTranslations("refunds.void.blocked");
  const format = useFormat();
  const online = useOnline();
  const { failure: failureText } = useFailureMessage();
  const [reason, setReason] = useState<VoidReason | null>(null);
  const [note, setNote] = useState("");
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });
  const [pinOpen, setPinOpen] = useState(false);
  const [problem, setProblem] = useState<FailureView | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const frozen = submit.kind !== "idle";

  const check = checkVoid({ sale, currentShiftId, reason, note, role });

  const send = async (input: VoidInputWire) => {
    setSubmit({ kind: "sending" });
    onBusy(true);
    setProblem(null);
    const outcome = await submitVoid(voidSaleAction, input);
    if (outcome.ok) {
      onBusy(false);
      onDone(outcome.result);
      return;
    }
    if (outcome.kind === "unknown") {
      setSubmit({ kind: "unknown", input });
      return;
    }
    onBusy(false);
    setSubmit({ kind: "idle" });
    setProblem(outcome.view);
  };

  const sendWith = (token: string | null) => {
    if (!check.ok || reason === null) return;
    const input = buildVoidInput({ saleId: sale.id, reason, note, token });
    if (!voidInputSchema.safeParse(input).success) {
      setLocalError(t("errors.generic"));
      return;
    }
    void send(input);
  };

  const onPrimary = () => {
    if (!check.ok || frozen) return;
    if (check.needsApproval) setPinOpen(true);
    else sendWith(null);
  };

  const plan = check.plan;
  const needsApproval = !hasPermission(role, "pos.void");
  const ready = check.ok;
  const pending = !check.ok && check.pending && check.blocks.length === 0;

  return (
    <div className="space-y-4" data-testid="void-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SaleHeader sale={sale} shiftNote={null} />
        <Button type="button" variant="outline" onClick={onBack} disabled={frozen}>
          <ArrowLeft aria-hidden /> {t("panel.back")}
        </Button>
      </div>

      {!check.ok && check.blocks.length > 0 ? (
        <div
          role="alert"
          className="space-y-1 rounded-md bg-muted px-3 py-3 text-sm"
          data-testid="void-blocked"
        >
          <p className="flex items-center gap-2 font-medium">
            <Ban className="size-4" aria-hidden /> {t("void.cannot")}
          </p>
          <ul className="list-disc space-y-1 pl-6">
            {check.blocks.map((block) => (
              <li key={block}>{tb(VOID_BLOCK_KEY[block])}</li>
            ))}
          </ul>
          {check.blocks.includes("HAS_REFUNDS") || check.blocks.includes("SALE_IN_OTHER_SHIFT") ? (
            <p>{t("void.useRefund")}</p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2" aria-label={t("void.reasonTitle")}>
            <label htmlFor="void-reason" className="text-sm font-medium">
              {t("void.reason")}
            </label>
            <NativeSelect
              id="void-reason"
              value={reason ?? ""}
              disabled={frozen}
              onChange={(event) => setReason((event.target.value || null) as VoidReason | null)}
            >
              <option value="">{t("void.reasonPlaceholder")}</option>
              {VOID_REASONS.map((value) => (
                <option key={value} value={value}>
                  {t(`void.reasons.${value}`)}
                </option>
              ))}
            </NativeSelect>
            <label htmlFor="void-note" className="text-sm font-medium">
              {reason === "OTHER" ? t("panel.noteRequired") : t("panel.note")}
            </label>
            <Textarea
              id="void-note"
              value={note}
              maxLength={500}
              disabled={frozen}
              aria-required={reason === "OTHER"}
              onChange={(event) => setNote(event.target.value)}
            />
            {pending ? (
              <p className="text-sm text-muted-foreground">
                {reason === null ? t("void.needReason") : t("void.needNote")}
              </p>
            ) : null}
            {plan && needsApproval ? (
              <p className="rounded-md bg-warning/20 px-3 py-2 text-sm" data-testid="void-approval">
                {t("void.approval", { total: format.money(sale.totalAmount) })}
              </p>
            ) : null}
          </section>

          <section className="space-y-2" aria-label={t("void.effectTitle")}>
            <p className="text-sm font-medium">{t("void.effectTitle")}</p>
            <ul className="space-y-1 text-sm" data-testid="void-effect">
              {sale.payments.map((payment) => (
                <li key={payment.id} className="flex justify-between gap-3">
                  <span>{t("void.reverse", { method: tm(payment.method) })}</span>
                  <span className="tabular-nums">{format.money(payment.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-baseline justify-between gap-3 border-t pt-2">
              <span className="font-semibold">{t("void.total")}</span>
              <span className="text-2xl font-bold tabular-nums" data-testid="void-total">
                {format.money(sale.totalAmount)}
              </span>
            </div>
            {plan && plan.cashReturned > 0n ? (
              <div className="rounded-lg bg-success/15 px-3 py-3" role="status">
                <p className="text-sm">{t("void.cashBack")}</p>
                <p className="text-4xl font-bold tabular-nums" data-testid="void-cash">
                  {format.money(plan.cashReturned)}
                </p>
              </div>
            ) : null}
            {plan && plan.stockRestores.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("void.stock", { count: plan.stockRestores.length })}
              </p>
            ) : null}
          </section>
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {problem ? (
          <div
            role="alert"
            className="space-y-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="void-problem"
          >
            <p>{failureText(problem)}</p>
            {isStale(problem) || isApprovalProblem(problem) ? (
              <Button type="button" variant="outline" onClick={() => onReload(false)}>
                {t("panel.reload")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {localError ? (
          <p role="alert" className="text-sm text-destructive">
            {localError}
          </p>
        ) : null}
        {!online ? (
          <p role="status" className="text-sm text-destructive">
            {t("panel.offline")}
          </p>
        ) : null}
        {submit.kind === "unknown" ? (
          <div
            role="alert"
            className="space-y-2 rounded-md bg-warning/25 px-3 py-2 text-sm"
            data-testid="void-unknown"
          >
            <p>{t("void.unknown")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void send(submit.input)}>
                {t("panel.retry")}
              </Button>
              <Button type="button" variant="outline" onClick={() => onReload(true)}>
                {t("panel.checkSale")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="sticky bottom-0 -mx-3 flex flex-col gap-2 border-t bg-background px-3 py-3 sm:-mx-6 sm:px-6 lg:flex-row lg:justify-end">
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="lg:min-w-64"
          disabled={!ready || frozen || !online}
          onClick={onPrimary}
          data-testid="void-submit"
        >
          {submit.kind === "sending"
            ? t("panel.sending")
            : t("void.submit", { total: format.money(sale.totalAmount) })}
        </Button>
      </div>

      {pinOpen && check.ok ? (
        <ApprovalPinDialog
          open
          onClose={() => setPinOpen(false)}
          items={[
            {
              key: check.key,
              permission: "pos.void",
              scope: check.scope,
              label: t("void.approval", { total: format.money(sale.totalAmount) }),
            },
          ]}
          onGranted={(grants, complete) => {
            if (!complete) return;
            setPinOpen(false);
            sendWith(grants[check.key]?.token ?? null);
          }}
        />
      ) : null}
    </div>
  );
}
