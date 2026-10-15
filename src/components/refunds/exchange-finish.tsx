"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { PosDialog } from "@/components/pos/pos-dialog";
import { TenderDialog } from "@/components/pos/tender-dialog";
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
import type {
  RefundApprovalRequirement,
  RefundInputWire,
  RefundResult,
} from "@/domain/refund-contract";
import { refundRequestSchema } from "@/domain/refund-contract";
import type { PosStore } from "@/hooks/use-pos-store";
import type { TenderDraft } from "@/lib/pos/charge";
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
import { refundAction } from "@/server/actions/refunds";

type Phase = "review" | "tender" | "sending" | "done";

/** One committed attempt, kept so an unknown outcome is resent byte for byte. */
interface Attempt {
  input: RefundInputWire;
  wire: CheckoutInputWire;
}

/**
 * Finishing an exchange: ONE idempotent `refundAction` call.
 *  1. review: totals, payout of any net refund, manager approvals up front;
 *  2. net due > 0: take the customer's tenders for the NET DUE only (the dialog
 *     just collects them; nothing is sent yet);
 *  3. `refundAction({ ...refund, exchange, exchangeCheckout })`: the service
 *     books the replacement sale (adding the EXCHANGE_CREDIT payment itself) and
 *     the refund in a single transaction, keyed by `refundId`. A lost answer is
 *     repaired by resending the identical request; it can never apply twice.
 */
export function ExchangeFinish({
  exchange,
  cashUnit,
  replacementSaleId,
  buildCheckout,
  store,
  startAtTender,
  onCommitted,
  onProblem,
  onClose,
  onFinished,
}: {
  exchange: ExchangeHandle;
  cashUnit: Money;
  /** The cart's sale id: the replacement sale. */
  replacementSaleId: string;
  /** Checkout wire for the cart with these tenders (the NET DUE; no credit tender). */
  buildCheckout: (tenders: readonly TenderDraft[]) => CheckoutInputWire;
  store: Pick<PosStore, "payment" | "setPayment" | "reconcilePayment">;
  /** A payment is in progress in the cart (e.g. an open QPay invoice): go straight to it. */
  startAtTender: boolean;
  /** The exchange is committed: clear the cart for the next sale. */
  onCommitted: () => void;
  onProblem: (
    kind: "STALE_PRICE" | "APPROVAL" | "SHIFT",
    details?: Record<string, unknown>,
  ) => void;
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
  const [changeDue, setChangeDue] = useState<Money>(0n);
  const attempt = useRef<Attempt | null>(null);

  if (!context || !sale || !quote) return null;
  const plan = quote.kind === "ok" ? quote.plan : null;
  const needed = quote.kind === "ok" ? quote.needed : [];
  const requirements = quote.kind === "ok" ? quote.requirements : [];
  const netDue = plan?.exchange?.netDue ?? 0n;
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

  const transmit = async (request: Attempt) => {
    attempt.current = request;
    setPhase("sending");
    setProblem(null);
    setMessage(null);
    setUnknown(false);
    const outcome = await submitRefund(
      (input) => refundAction({ ...input, exchangeCheckout: request.wire }),
      request.input,
    );
    if (outcome.ok) {
      attempt.current = null;
      setResult(outcome.result);
      setPhase("done");
      onCommitted();
      return;
    }
    if (outcome.kind === "unknown") {
      setUnknown(true);
      return;
    }
    attempt.current = null;
    setPhase("review");
    const view = outcome.view;
    if (view.kind === "contract") {
      const detail = view.details as { exchange?: boolean; checkout?: string } | undefined;
      if (isApprovalProblem(view) && detail?.exchange) {
        return onProblem("APPROVAL", view.details);
      }
      if (view.code === "EXCHANGE_INVALID" && detail?.checkout === "STALE_PRICE") {
        return onProblem("STALE_PRICE", view.details);
      }
      if (view.code === "SHIFT_NOT_OPEN") return onProblem("SHIFT", view.details);
    }
    setProblem(view);
    if (isApprovalProblem(view)) setHeld({});
  };

  const sendRefund = (wire: CheckoutInputWire, tokens: HeldApprovals, changeBack: Money) => {
    if (!plan) return;
    const input = buildRefundInput({
      refundId: context.refundId,
      sale,
      draft: context.draft,
      plan,
      approvals: approvalTokensFor(requirements, tokens),
      exchange: { saleId: wire.saleId, expectedPayable: payable },
    });
    if (!refundRequestSchema.safeParse(input).success) {
      setMessage(t("failed"));
      return;
    }
    setChangeDue(changeBack);
    void transmit({ input, wire });
  };

  const proceed = (tokens: HeldApprovals) => {
    if (netDue > 0n) {
      store.reconcilePayment(netDue);
      setPhase("tender");
    } else {
      sendRefund(buildCheckout([]), tokens, 0n);
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
        <RefundDone
          result={result}
          changeDue={changeDue}
          onAnother={onFinished}
          onClose={onFinished}
        />
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
        buildInput={buildCheckout}
        resume={null}
        onPending={() => undefined}
        onCollected={(wire, tenders) =>
          sendRefund(
            wire,
            held,
            tenders.reduce(
              (acc, x) => (x.method === "CASH" && x.tendered ? acc + x.tendered - x.amount : acc),
              0n,
            ),
          )
        }
        onProblem={() => undefined}
      />
    );
  }

  const busy = phase === "sending";
  return (
    <PosDialog
      open
      onClose={onClose}
      title={t("finishTitle")}
      description={t("finishDescription")}
      locked={busy}
      className="sm:max-w-xl"
    >
      <div className="space-y-4" data-testid="exchange-finish-dialog">
        <RefundSummary plan={plan} replacementTotal={payable} />
        {netRefund > 0n ? (
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
                  if (attempt.current) void transmit(attempt.current);
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
            {netDue > 0n ? t("takePayment", { amount: format.money(netDue) }) : t("confirm")}
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
