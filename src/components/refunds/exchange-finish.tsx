"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { PosDialog } from "@/components/pos/pos-dialog";
import { TenderDialog, type TenderDialogProps } from "@/components/pos/tender-dialog";
import { ApprovalPinDialog, type ApprovalItem } from "@/components/refunds/approval-pin-dialog";
import { RefundDone } from "@/components/refunds/done-views";
import { PayoutEditor } from "@/components/refunds/payout-editor";
import { RefundSummary } from "@/components/refunds/refund-summary";
import { useFailureMessage } from "@/components/refunds/use-failure-message";
import type { ExchangeHandle } from "@/components/refunds/use-exchange";
import { useFormat } from "@/components/pos/use-format";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import type { CheckoutInputWire } from "@/domain/checkout-contract";
import type { Money } from "@/domain/money";
import type { RefundApprovalRequirement, RefundResult } from "@/domain/refund-contract";
import { refundRequestSchema } from "@/domain/refund-contract";
import type { PosStore } from "@/hooks/use-pos-store";
import { submitCheckout, type TenderDraft } from "@/lib/pos/charge";
import { isApprovalProblem, type FailureView } from "@/lib/refunds/errors";
import {
  approvalTokensFor,
  buildRefundInput,
  missingApprovals,
  type HeldApprovals,
  type HeldApproval,
  type PayoutChoice,
} from "@/lib/refunds/plan";
import { submitRefund } from "@/lib/refunds/submit";
import { checkoutAction } from "@/server/actions/checkout";
import { refundAction } from "@/server/actions/refunds";

type Phase =
  | "review"
  | "tender"
  /** Replacement fully covered by the credit: checkout without a tender dialog. */
  | "credit"
  | "refund"
  | "done";

/**
 * Finishing an exchange, in this order (each step idempotent):
 *  1. review: totals, payout of any net refund, manager approvals up front;
 *  2. the replacement checkout (net due tendered normally + the exchange
 *     credit as an EXCHANGE_CREDIT tender);
 *  3. the refund that links it (`exchange: { saleId, expectedPayable }`).
 * A failure after step 2 leaves the exchange open in the register ("complete
 * the refund") so it can be finished with a retry, never repeated.
 */
export function ExchangeFinish({
  exchange,
  cashUnit,
  replacementSaleId,
  buildCheckout,
  store,
  startAtTender,
  onCheckedOut,
  onProblem,
  onClose,
  onFinished,
}: {
  exchange: ExchangeHandle;
  cashUnit: Money;
  /** The cart's sale id: the replacement sale. */
  replacementSaleId: string;
  /** Checkout wire for the cart with these tenders plus the credit tender (null = none). */
  buildCheckout: (tenders: readonly TenderDraft[], credit: Money) => CheckoutInputWire;
  store: Pick<
    PosStore,
    "payment" | "setPayment" | "pendingCharge" | "setPendingCharge" | "reconcilePayment"
  >;
  /** The cart has an unconfirmed charge: go straight to the tender step. */
  startAtTender: boolean;
  /** The replacement sale is committed: clear the cart, remember it for the refund. */
  onCheckedOut: (saleId: string, payable: Money) => void;
  onProblem: TenderDialogProps["onProblem"];
  onClose: () => void;
  onFinished: () => void;
}) {
  const t = useTranslations("refunds.exchange");
  const format = useFormat();
  const { failure: failureText } = useFailureMessage();
  const { context, sale, quote, payable } = exchange;
  const [phase, setPhase] = useState<Phase>(startAtTender ? "tender" : "review");
  const [held, setHeld] = useState<HeldApprovals>({});
  const [pinFor, setPinFor] = useState<readonly ApprovalItem[] | null>(null);
  const [problem, setProblem] = useState<FailureView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [result, setResult] = useState<RefundResult | null>(null);
  // The checkout wire of the credit-only path, resent verbatim after an unknown outcome.
  const creditWire = useRef<CheckoutInputWire | null>(null);

  if (!context || !sale || !quote) return null;
  const plan = quote.kind === "ok" ? quote.plan : null;
  const needed = quote.kind === "ok" ? quote.needed : [];
  const requirements = quote.kind === "ok" ? quote.requirements : [];
  const netDue = plan?.exchange?.netDue ?? 0n;
  const credit = plan?.exchange?.creditApplied ?? 0n;
  const checkedOut = context.checkedOut;
  const netRefund = plan?.exchange?.netRefund ?? 0n;

  const describe = (requirement: RefundApprovalRequirement): string => {
    if (requirement.key === "refund") {
      return t("approvalRefund", { total: plan ? format.money(plan.totalAmount) : "—" });
    }
    if (requirement.key === "refund:method") return t("approvalMethod");
    return t("approvalWindow");
  };

  const setPayout = (payout: PayoutChoice) => {
    exchange.update({ ...context, draft: { ...context.draft, payout } });
  };

  const sendRefund = async (replacementId: string, tokens: HeldApprovals) => {
    if (!plan) return;
    setPhase("refund");
    setProblem(null);
    setMessage(null);
    setUnknown(false);
    const input = buildRefundInput({
      refundId: context.refundId,
      sale,
      draft: context.draft,
      plan,
      approvals: approvalTokensFor(requirements, tokens),
      exchange: { saleId: replacementId, expectedPayable: payable },
    });
    if (!refundRequestSchema.safeParse(input).success) {
      setMessage(t("failed"));
      return;
    }
    const outcome = await submitRefund(refundAction, input);
    if (outcome.ok) {
      setResult(outcome.result);
      setPhase("done");
    } else if (outcome.kind === "unknown") {
      setUnknown(true);
    } else {
      setProblem(outcome.view);
      if (isApprovalProblem(outcome.view)) setHeld({});
    }
  };

  const runCreditOnly = async () => {
    setPhase("credit");
    setMessage(null);
    setUnknown(false);
    const wire = creditWire.current ?? buildCheckout([], credit);
    creditWire.current = wire;
    store.setPendingCharge(wire);
    const outcome = await submitCheckout(checkoutAction, wire);
    if (outcome.ok) {
      creditWire.current = null;
      store.setPendingCharge(null);
      onCheckedOut(outcome.result.saleId, payable);
      void sendRefund(outcome.result.saleId, held);
    } else if (outcome.kind === "unknown") {
      setUnknown(true);
    } else {
      creditWire.current = null;
      store.setPendingCharge(null);
      setMessage(t("checkoutFailed"));
    }
  };

  const proceed = (tokens: HeldApprovals) => {
    if (checkedOut) {
      void sendRefund(checkedOut.saleId, tokens);
    } else if (netDue > 0n) {
      store.reconcilePayment(netDue);
      setPhase("tender");
    } else {
      void runCreditOnly();
    }
  };

  const onContinue = () => {
    const missing = missingApprovals(needed, held);
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
    proceed(held);
  };

  const onGranted = (grants: Record<string, HeldApproval>, complete: boolean) => {
    const merged = { ...held, ...grants };
    setHeld(merged);
    if (!complete) return;
    setPinFor(null);
    proceed(merged);
  };

  if (phase === "done" && result) {
    return (
      <PosDialog open onClose={onFinished} title={t("doneTitle")} locked>
        <RefundDone result={result} onAnother={onFinished} onClose={onFinished} />
      </PosDialog>
    );
  }

  if (phase === "tender") {
    return (
      <TenderDialog
        open
        onClose={() => setPhase("review")}
        payment={store.payment}
        onPayment={store.setPayment}
        payable={netDue}
        cashUnit={cashUnit}
        saleId={replacementSaleId}
        buildInput={(tenders) => buildCheckout(tenders, credit)}
        charge={checkoutAction}
        resume={store.pendingCharge}
        onPending={store.setPendingCharge}
        onSuccess={(checkout) => {
          onCheckedOut(checkout.saleId, payable);
          void sendRefund(checkout.saleId, held);
        }}
        onProblem={(kind, details) => {
          setPhase("review");
          onProblem(kind, details);
        }}
      />
    );
  }

  const busy = phase === "credit" || phase === "refund";
  return (
    <PosDialog
      open
      onClose={onClose}
      title={t("finishTitle")}
      description={checkedOut ? t("resumeDescription") : t("finishDescription")}
      locked={busy}
      className="sm:max-w-xl"
    >
      <div className="space-y-4" data-testid="exchange-finish-dialog">
        <RefundSummary plan={plan} replacementTotal={payable} />
        {netRefund > 0n && !checkedOut ? (
          <PayoutEditor
            choice={context.draft.payout}
            onChange={setPayout}
            netRefund={netRefund}
            disabled={busy}
          />
        ) : null}
        {needed.length > 0 ? (
          <div
            className="space-y-1 rounded-md bg-warning/20 px-3 py-2 text-sm"
            data-testid="exchange-approvals"
          >
            <ul className="space-y-1">
              {needed.map((requirement) => (
                <li key={requirement.key} className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{describe(requirement)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {quote.kind === "invalid" ? (
          <p role="alert" className="text-sm text-destructive">
            {t("invalid")}
          </p>
        ) : null}
        <div aria-live="polite" className="space-y-2">
          {problem ? (
            <p role="alert" className="text-sm text-destructive" data-testid="exchange-problem">
              {failureText(problem)}
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          {unknown ? (
            <div role="alert" className="space-y-2 rounded-md bg-warning/25 px-3 py-2 text-sm">
              <p>{t("unknown")}</p>
              <Button
                onClick={() => {
                  if (phase === "credit") void runCreditOnly();
                  else if (checkedOut) void sendRefund(checkedOut.saleId, held);
                }}
              >
                {t("retrySend")}
              </Button>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("back")}
          </Button>
          <Button
            onClick={onContinue}
            disabled={busy || plan === null}
            data-testid="exchange-continue"
          >
            {busy ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : null}
            {checkedOut
              ? t("completeRefund")
              : netDue > 0n
                ? t("takePayment", { amount: format.money(netDue) })
                : t("confirm")}
          </Button>
        </DialogFooter>
      </div>
      {pinFor ? (
        <ApprovalPinDialog
          open
          onClose={() => setPinFor(null)}
          items={pinFor}
          onGranted={onGranted}
        />
      ) : null}
    </PosDialog>
  );
}
