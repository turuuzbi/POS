"use client";

import { AlertTriangle, ArrowLeft, Ban, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { ApprovalPinDialog, type ApprovalItem } from "@/components/refunds/approval-pin-dialog";
import { PayoutEditor } from "@/components/refunds/payout-editor";
import { RefundSummary } from "@/components/refunds/refund-summary";
import { ReturnLineRow } from "@/components/refunds/return-line-row";
import { SaleHeader } from "@/components/refunds/sale-header";
import { useFailureMessage } from "@/components/refunds/use-failure-message";
import { useFormat } from "@/components/pos/use-format";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Role } from "@/domain/permissions";
import { RETURN_REASONS, type ReturnReason } from "@/domain/refund";
import type {
  RefundApprovalRequirement,
  RefundInputWire,
  RefundResult,
} from "@/domain/refund-contract";
import { refundRequestSchema } from "@/domain/refund-contract";
import { useOnline } from "@/hooks/use-online";
import { isApprovalProblem, isStale, type FailureView } from "@/lib/refunds/errors";
import type { ExchangeContext } from "@/lib/refunds/exchange";
import {
  approvalTokensFor,
  buildRefundInput,
  EMPTY_DRAFT,
  missingApprovals,
  previewRefund,
  progressOf,
  saleAgeDays,
  saleState,
  stepQty,
  withAll,
  withQty,
  withRestock,
  type Draft,
  type HeldApproval,
  type HeldApprovals,
  type Preview,
} from "@/lib/refunds/plan";
import type { ReturnSale } from "@/lib/refunds/sale-wire";
import { submitRefund } from "@/lib/refunds/submit";
import { checkVoid, VOID_BLOCK_KEY } from "@/lib/refunds/void";
import { refundAction } from "@/server/actions/refunds";

export interface SaleMeta {
  maxRefundWindowDays: number | null;
  roundingUnit: bigint;
}

type Submit =
  | { kind: "idle" }
  | { kind: "sending" }
  /** No usable answer: the refund may exist. Inputs stay frozen; resend the SAME input. */
  | { kind: "unknown"; input: RefundInputWire };

export interface SalePanelProps {
  sale: ReturnSale;
  meta: SaleMeta;
  role: Role;
  currentShiftId: string | null;
  initialMode?: "RETURN" | "EXCHANGE";
  onBack: () => void;
  onVoid: () => void;
  onDone: (result: RefundResult) => void;
  /** Re-read the sale (after a stale error or an unknown outcome). */
  onReload: (checkRefundId: string | null) => void;
  /** Exchange: hand the chosen lines to the register cart. */
  onStartExchange: (context: ExchangeContext) => void;
  /** Lock the surrounding dialog while a request is in flight or unresolved. */
  onBusy: (busy: boolean) => void;
}

/**
 * The Returns form for one sale: pick lines and quantities, reason, payout;
 * the preview is the domain's `planRefund` run on the client with the inputs
 * the server will use. Submitting sends one idempotent refund (the id is
 * created when the sale opens); an unknown outcome freezes the form until the
 * same request is resent or the sale is re-read.
 */
export function SalePanel(props: SalePanelProps) {
  const { sale, meta, role, currentShiftId, onBack, onVoid, onDone, onReload, onBusy } = props;
  const t = useTranslations("refunds");
  const tb = useTranslations("refunds.void.blocked");
  const format = useFormat();
  const online = useOnline();
  const { failure: failureText, issue: issueText } = useFailureMessage();

  // One refund id per opening of this sale: a retry reuses it, a new return gets a new one.
  const [refundId] = useState(() => uuidv7());
  const [now] = useState(() => new Date());
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [mode, setMode] = useState<"RETURN" | "EXCHANGE">(props.initialMode ?? "RETURN");
  const [held, setHeld] = useState<HeldApprovals>({});
  const [pinFor, setPinFor] = useState<readonly ApprovalItem[] | null>(null);
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });
  const [problem, setProblem] = useState<FailureView | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const progress = useMemo(() => progressOf(sale), [sale]);
  const state = saleState(sale);
  const closed = state === "VOIDED" || state === "REFUNDED";
  const frozen = submit.kind !== "idle";
  const exchange = mode === "EXCHANGE";

  const preview: Preview = useMemo(
    () =>
      previewRefund({
        refundId,
        sale,
        draft,
        now,
        roundingUnit: meta.roundingUnit,
        maxRefundWindowDays: meta.maxRefundWindowDays,
        role,
      }),
    [refundId, sale, draft, now, meta, role],
  );
  const plan = preview.kind === "ok" ? preview.plan : null;
  const blockers = preview.kind === "empty" ? [] : preview.blockers;
  const ready = preview.kind === "ok" && blockers.length === 0;
  const missing = preview.kind === "ok" ? missingApprovals(preview.needed, held) : [];

  const age = saleAgeDays(sale, now);
  const windowDays = meta.maxRefundWindowDays;
  const outsideWindow =
    (preview.kind === "ok" && preview.outsideWindow) || (windowDays !== null && age > windowDays);

  const voidCheck = checkVoid({ sale, currentShiftId, reason: "ENTRY_ERROR", note: "", role });
  const voidBlock = voidCheck.ok ? null : (voidCheck.blocks[0] ?? null);

  const update = (next: Draft) => {
    setDraft(next);
    setProblem(null);
    setLocalError(null);
  };

  const describe = (requirement: RefundApprovalRequirement): string => {
    if (requirement.key === "refund") {
      return t("approval.refund", { total: plan ? format.money(plan.totalAmount) : "—" });
    }
    if (requirement.key === "refund:method") return t("approval.method");
    return t("approval.window", { days: windowDays ?? 0 });
  };

  const send = async (input: RefundInputWire) => {
    setSubmit({ kind: "sending" });
    onBusy(true);
    setProblem(null);
    const outcome = await submitRefund(refundAction, input);
    if (outcome.ok) {
      onBusy(false);
      onDone(outcome.result);
      return;
    }
    if (outcome.kind === "unknown") {
      setSubmit({ kind: "unknown", input });
      return; // stays busy: the dialog cannot be dismissed while the outcome is unknown
    }
    onBusy(false);
    setSubmit({ kind: "idle" });
    setProblem(outcome.view);
    if (isApprovalProblem(outcome.view)) setHeld({});
  };

  const sendWith = (tokens: HeldApprovals) => {
    if (preview.kind !== "ok") return;
    const input = buildRefundInput({
      refundId,
      sale,
      draft,
      plan: preview.plan,
      approvals: approvalTokensFor(preview.requirements, tokens),
    });
    // The same schema the server applies: a client-side slip never reaches the wire.
    if (!refundRequestSchema.safeParse(input).success) {
      setLocalError(t("errors.generic"));
      return;
    }
    void send(input);
  };

  const onPrimary = () => {
    if (!ready || preview.kind !== "ok" || frozen) return;
    if (exchange) {
      if (draft.reason === null) return;
      props.onStartExchange({
        refundId,
        saleId: sale.id,
        saleNumber: sale.number,
        draft: { ...draft, reason: draft.reason },
      });
      return;
    }
    if (missing.length > 0) {
      setPinFor(
        missing.map((r) => ({
          key: r.key,
          permission: r.permission,
          scope: r.scope,
          label: describe(r),
        })),
      );
      return;
    }
    sendWith(held);
  };

  const onGranted = (grants: Record<string, HeldApproval>, complete: boolean) => {
    const merged = { ...held, ...grants };
    setHeld(merged);
    if (!complete) return;
    setPinFor(null);
    sendWith(merged);
  };

  const issues = preview.kind === "invalid" ? preview.issues : [];
  const total = plan ? format.money(plan.totalAmount) : null;
  const netRefund = plan ? (plan.exchange?.netRefund ?? plan.totalAmount) : 0n;
  const shiftNote =
    currentShiftId !== null && sale.shiftId !== currentShiftId ? t("sale.otherShift") : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SaleHeader sale={sale} shiftNote={shiftNote} />
        <Button type="button" variant="outline" onClick={onBack} disabled={frozen}>
          <ArrowLeft aria-hidden /> {t("panel.back")}
        </Button>
      </div>

      {state === "VOIDED" ? (
        <p role="status" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <Ban className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("panel.voidedNote")}
        </p>
      ) : null}
      {state === "REFUNDED" ? (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {t("panel.refundedNote")}
        </p>
      ) : null}
      {outsideWindow && windowDays !== null && !closed ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-warning/25 px-3 py-2 text-sm"
          data-testid="window-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("panel.windowWarning", { age, days: windowDays })}
        </p>
      ) : null}

      {!closed ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="space-y-3" aria-label={t("panel.linesTitle")}>
            <div
              role="radiogroup"
              aria-label={t("panel.modeLabel")}
              className="grid grid-cols-2 gap-2"
            >
              {(["RETURN", "EXCHANGE"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  variant={mode === value ? "default" : "outline"}
                  disabled={frozen}
                  onClick={() => setMode(value)}
                  data-testid={`mode-${value}`}
                >
                  {t(`panel.mode.${value}`)}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {exchange ? t("panel.exchangeHint") : t("panel.returnHint")}
            </p>
            <ul className="space-y-2" data-testid="return-lines">
              {sale.lines.map((line) => {
                const lineProgress = progress.get(line.id);
                if (!lineProgress) return null;
                return (
                  <ReturnLineRow
                    key={line.id}
                    line={line}
                    progress={lineProgress}
                    choice={draft.choices[line.id]}
                    disabled={frozen}
                    onStep={(direction) =>
                      update({
                        ...draft,
                        choices: stepQty(draft.choices, line, lineProgress, direction),
                      })
                    }
                    onAll={() =>
                      update({ ...draft, choices: withAll(draft.choices, line, lineProgress) })
                    }
                    onSetQty={(qty) =>
                      update({ ...draft, choices: withQty(draft.choices, line, lineProgress, qty) })
                    }
                    onRestock={(restock) =>
                      update({ ...draft, choices: withRestock(draft.choices, line.id, restock) })
                    }
                  />
                );
              })}
            </ul>
          </section>

          <section className="space-y-4" aria-label={t("panel.detailsTitle")}>
            <div className="space-y-2">
              <label htmlFor="refund-reason" className="text-sm font-medium">
                {t("panel.reason")}
              </label>
              <NativeSelect
                id="refund-reason"
                value={draft.reason ?? ""}
                disabled={frozen}
                onChange={(event) =>
                  update({
                    ...draft,
                    reason: (event.target.value || null) as ReturnReason | null,
                  })
                }
              >
                <option value="">{t("panel.reasonPlaceholder")}</option>
                {RETURN_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`reason.${reason}`)}
                  </option>
                ))}
              </NativeSelect>
              <label htmlFor="refund-note" className="text-sm font-medium">
                {draft.reason === "OTHER" ? t("panel.noteRequired") : t("panel.note")}
              </label>
              <Textarea
                id="refund-note"
                value={draft.note}
                maxLength={500}
                disabled={frozen}
                aria-required={draft.reason === "OTHER"}
                onChange={(event) => update({ ...draft, note: event.target.value })}
              />
            </div>

            {!exchange ? (
              <PayoutEditor
                choice={draft.payout}
                onChange={(payout) => update({ ...draft, payout })}
                netRefund={netRefund}
                disabled={frozen}
              />
            ) : null}

            <RefundSummary plan={plan} />

            {preview.kind === "ok" && preview.needed.length > 0 && !exchange ? (
              <div
                className="space-y-1 rounded-md bg-warning/20 px-3 py-2 text-sm"
                data-testid="approval-needed"
              >
                <p className="font-medium">{t("approval.title")}</p>
                <ul className="space-y-1">
                  {preview.needed.map((requirement) => {
                    const granted = held[requirement.key]?.scope === requirement.scope;
                    return (
                      <li key={requirement.key} className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span>
                          {describe(requirement)}
                          {granted
                            ? ` — ${t("approval.granted", { name: held[requirement.key]!.approverName })}`
                            : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      <div aria-live="polite" className="space-y-2">
        {issues.length > 0 ? (
          <ul
            role="alert"
            className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="refund-issues"
          >
            {issues.map((item, index) => (
              <li key={`${item.code}-${index}`}>{issueText(item)}</li>
            ))}
          </ul>
        ) : null}
        {blockers.length > 0 && preview.kind !== "empty" ? (
          <p className="text-sm text-muted-foreground" data-testid="refund-blockers">
            {blockers.includes("REASON") ? t("panel.needReason") : t("panel.needNote")}
          </p>
        ) : null}
        {problem ? (
          <div
            role="alert"
            className="space-y-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="refund-problem"
          >
            <p>{failureText(problem)}</p>
            {isStale(problem) ? (
              <Button type="button" variant="outline" onClick={() => onReload(null)}>
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
            data-testid="refund-unknown"
          >
            <p>{t("panel.unknown")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void send(submit.input)}>
                {t("panel.retry")}
              </Button>
              <Button type="button" variant="outline" onClick={() => onReload(refundId)}>
                {t("panel.checkSale")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {!closed ? (
        <div className="sticky bottom-0 -mx-3 flex flex-col gap-2 border-t bg-background px-3 py-3 sm:-mx-6 sm:px-6 lg:flex-row lg:items-center lg:justify-end">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={frozen || voidBlock !== null}
            onClick={onVoid}
            data-testid="void-sale"
          >
            {t("panel.void")}
          </Button>
          <Button
            type="button"
            size="lg"
            className="lg:min-w-64"
            disabled={!ready || frozen || (!online && !exchange)}
            onClick={onPrimary}
            data-testid="refund-submit"
          >
            {submit.kind === "sending"
              ? t("panel.sending")
              : exchange
                ? t("panel.chooseReplacement")
                : total
                  ? t("panel.refundAmount", { total })
                  : t("panel.refund")}
          </Button>
        </div>
      ) : null}
      {voidBlock !== null && !closed ? (
        <p className="text-sm text-muted-foreground" data-testid="void-blocked">
          {tb(VOID_BLOCK_KEY[voidBlock])}
        </p>
      ) : null}

      {pinFor ? (
        <ApprovalPinDialog
          open
          onClose={() => setPinFor(null)}
          items={pinFor}
          onGranted={onGranted}
        />
      ) : null}
    </div>
  );
}
