"use client";

import { Banknote, CreditCard, Landmark, Loader2, QrCode, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CheckoutInputWire, CheckoutResult } from "@/domain/checkout-contract";
import { MINOR_PER_MAJOR, sum, type Money } from "@/domain/money";
import {
  cashTenderFor,
  quickCashAmounts,
  remainingBalance,
  validateTenders,
  MAX_TENDERS,
} from "@/domain/tender";
import { submitCheckout, type ChargeOutcome, type TenderDraft } from "@/lib/pos/charge";
import { moneyToInput, parseKeypadMoney } from "@/lib/pos/money-input";
import {
  addPaymentTender,
  removePaymentTender,
  setPaymentInvoice,
  type PaymentState,
} from "@/lib/pos/payment-state";
import type { ActionResult } from "@/server/actions/define-action";
import { KeypadField } from "./keypad";
import { PosDialog } from "./pos-dialog";
import { QpayPanel } from "./qpay-panel";
import { useFormat } from "./use-format";

type Method = "CASH" | "CARD" | "BANK_TRANSFER" | "QPAY";

const METHODS: { method: Method; icon: typeof Banknote }[] = [
  { method: "CASH", icon: Banknote },
  { method: "CARD", icon: CreditCard },
  { method: "BANK_TRANSFER", icon: Landmark },
  { method: "QPAY", icon: QrCode },
];

type Submit =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  /** No usable answer: the sale may exist. Retrying the same input is always safe. */
  | { kind: "unknown" };

/** Loose `t` for the checkout namespace owned by the service slice. */
type LooseT = { (key: string): string; has(key: string): boolean };

export interface TenderDialogProps {
  open: boolean;
  onClose: () => void;
  payable: Money;
  cashUnit: Money;
  /** Wire input for the given tenders (cart, approvals and saleId come from the parent). */
  buildInput: (tenders: readonly TenderDraft[]) => CheckoutInputWire;
  charge?: (input: CheckoutInputWire) => Promise<ActionResult<unknown>>;
  saleId: string;
  /** An earlier attempt whose outcome is unknown, resent verbatim. */
  resume: CheckoutInputWire | null;
  onPending: (input: CheckoutInputWire | null) => void;
  onSuccess?: (result: CheckoutResult, tenders: readonly TenderDraft[]) => void;
  /**
   * Collect-only mode (exchange): once the balance is covered, hand the built
   * input to the parent instead of sending it. The parent sends the sale
   * itself, inside the refund that links it.
   */
  onCollected?: (input: CheckoutInputWire, tenders: readonly TenderDraft[]) => void;
  /**
   * The server rejected the prices / approvals; the parent reacts, then reopens.
   * DUPLICATE_SALE: this sale id was already recorded and this register did not
   * send it before (another tab or a stale draft); nothing new was charged.
   */
  onProblem: (
    kind: "STALE_PRICE" | "APPROVAL" | "SHIFT" | "DUPLICATE_SALE",
    details?: Record<string, unknown>,
  ) => void;
  /** Payments taken so far; they belong to the register store, not to this dialog. */
  payment: PaymentState;
  onPayment: (update: (current: PaymentState) => PaymentState) => void;
}

/**
 * Take payment: cash (quick amounts, change due), card, bank transfer and QPay,
 * alone or split. Sends the sale once the balance is exactly covered.
 */
export function TenderDialog(props: TenderDialogProps) {
  const { open, onClose, payable, cashUnit, saleId, resume } = props;
  const t = useTranslations("pos.tender");
  const te = useTranslations("errors");
  const tAll = useTranslations() as unknown as LooseT;
  const format = useFormat();
  const { payment, onPayment } = props;
  const tenders = payment.tenders;
  /** An invoice is open: the customer may be paying right now. */
  const awaiting = payment.invoice !== null;
  const [method, setMethod] = useState<Method>(awaiting ? "QPAY" : "CASH");
  const [text, setText] = useState("");
  const [reference, setReference] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<Submit>(resume ? { kind: "unknown" } : { kind: "idle" });
  const [lastInput, setLastInput] = useState<CheckoutInputWire | null>(resume);
  const refId = useId();
  const errId = useId();

  const remaining = remainingBalance(payable, tenders);
  // A sale that costs nothing (100% discount, rounds to zero) has nothing to tender.
  const settled = remaining === 0n && (tenders.length > 0 || payable === 0n);
  const sending = submit.kind === "sending";
  const decimals = cashUnit < MINOR_PER_MAJOR ? 2 : 0;
  const unknownOnly = submit.kind === "unknown" && resume !== null && tenders.length === 0;

  // Non-cash tenders default to the remaining balance; cash starts empty. Reset
  // the typed amount when the balance or the method changes (state adjusted
  // during render, as React recommends, instead of in an effect).
  const resetKey = `${method}:${remaining}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setFieldError(null);
    setText(method === "CASH" || remaining <= 0n ? "" : moneyToInput(remaining));
  }

  const typed = parseKeypadMoney(text);
  const changeDue =
    method === "CASH" && typed !== null && remaining > 0n && typed > remaining
      ? typed - remaining
      : 0n;

  const addTender = (tender: TenderDraft) => {
    onPayment((p) => addPaymentTender(p, tender, payable));
    setReference("");
    setFieldError(null);
  };

  const addCash = (tendered: Money | null) => {
    if (tendered === null || tendered <= 0n || remaining <= 0n) return;
    const tender = cashTenderFor(remaining, tendered);
    if (tender.amount % cashUnit !== 0n || tendered % cashUnit !== 0n) {
      setFieldError(t("errors.cashUnits"));
      return;
    }
    addTender({ ...tender, tendered });
  };

  const addOther = () => {
    if (typed === null || typed <= 0n) {
      setFieldError(t("errors.amount"));
      return;
    }
    if (typed > remaining) {
      setFieldError(t("errors.exceeds", { remaining: format.money(remaining) }));
      return;
    }
    if (method === "BANK_TRANSFER" && !reference.trim()) {
      setFieldError(t("errors.reference"));
      return;
    }
    addTender({
      method: method === "CARD" ? "CARD" : "BANK_TRANSFER",
      amount: typed,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    });
  };

  const failureMessage = (outcome: Extract<ChargeOutcome, { ok: false }>): string => {
    if (outcome.kind === "checkout") {
      const key = `checkout.errors.${outcome.code}`;
      return tAll.has(key) ? tAll(key) : t("errors.generic", { code: outcome.code });
    }
    if (outcome.kind === "action") return te(outcome.code);
    return t("errors.unknown");
  };

  // Has this dialog (or an earlier one, before a reload) ever sent this sale without
  // getting a usable answer? Only then is a replayed result "our own" sale.
  const mayHaveSent = useRef(resume !== null);
  const autoRetries = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = async (wire: CheckoutInputWire, used: readonly TenderDraft[]) => {
    if (!props.charge) return;
    setSubmit({ kind: "sending" });
    setLastInput(wire);
    props.onPending(wire);
    const outcome = await submitCheckout(props.charge, wire);
    if (outcome.ok) {
      const ours = mayHaveSent.current || outcome.attempts > 1;
      props.onPending(null);
      if (outcome.result.replayed && !ours) {
        return props.onProblem("DUPLICATE_SALE");
      }
      props.onSuccess?.(outcome.result, used);
      return;
    }
    if (outcome.kind === "unknown") {
      mayHaveSent.current = true;
      setSubmit({ kind: "unknown" }); // keep the pending input: a retry replays it
      return;
    }
    props.onPending(null);
    if (outcome.kind === "checkout") {
      if (outcome.code === "IDEMPOTENCY_CONFLICT" && !mayHaveSent.current) {
        return props.onProblem("DUPLICATE_SALE");
      }
      if (outcome.code === "STALE_PRICE") return props.onProblem("STALE_PRICE", outcome.details);
      if (outcome.code === "APPROVAL_REQUIRED" || outcome.code === "APPROVAL_INVALID") {
        return props.onProblem("APPROVAL", outcome.details);
      }
      if (outcome.code === "SHIFT_REQUIRED") return props.onProblem("SHIFT", outcome.details);
    }
    setSubmit({ kind: "error", message: failureMessage(outcome) });
  };

  const complete = () => {
    if (!settled || sending) return;
    const validation = validateTenders(payable, tenders, { cashUnit });
    if (!validation.ok) {
      setSubmit({ kind: "error", message: t("errors.tenders") });
      return;
    }
    if (props.onCollected) {
      props.onCollected(props.buildInput(tenders), tenders);
      return;
    }
    void send(props.buildInput(tenders), tenders);
  };

  const retry = () => {
    if (lastInput) void send(lastInput, tenders);
  };

  // An unconfirmed charge is asked again by itself (same sale id, so never a second
  // charge): a few times with growing pauses, then the cashier's button.
  const retryRef = useRef(retry);
  useEffect(() => {
    retryRef.current = retry;
  });
  const unknown = submit.kind === "unknown";
  useEffect(() => {
    if (!unknown || autoRetries.current >= 4) return;
    const timer = setTimeout(
      () => {
        if (!mounted.current) return;
        autoRetries.current += 1;
        retryRef.current();
      },
      3000 * 2 ** autoRetries.current,
    );
    return () => clearTimeout(timer);
  }, [unknown, submit]);

  const totalChange = sum(
    tenders.map((x) => (x.method === "CASH" && x.tendered ? x.tendered - x.amount : 0n)),
  );

  return (
    <PosDialog
      open={open}
      onClose={onClose}
      title={t("title")}
      description={t("description")}
      locked={sending || awaiting}
      className="sm:max-w-xl"
    >
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg bg-muted px-3 py-2">
          <p className="text-xs text-muted-foreground">{t("payable")}</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="tender-payable">
            {format.money(payable)}
          </p>
        </div>
        <div className="rounded-lg bg-muted px-3 py-2" aria-live="polite" aria-atomic="true">
          <p className="text-xs text-muted-foreground">{t("remaining")}</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="tender-remaining">
            {format.money(remaining > 0n ? remaining : 0n)}
          </p>
        </div>
      </div>

      {tenders.length > 0 ? (
        <ul className="divide-y rounded-md border" aria-label={t("applied")}>
          {tenders.map((tender, index) => (
            <li key={index} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 text-sm">
                {t(`method.${tender.method as Method}`)}
                {tender.reference ? (
                  <span className="text-muted-foreground"> · {tender.reference}</span>
                ) : null}
                {tender.method === "CASH" && tender.tendered && tender.tendered > tender.amount ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {t("given", { amount: format.money(tender.tendered) })}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-1">
                <span className="font-semibold tabular-nums">{format.money(tender.amount)}</span>
                {tender.method === "QPAY" || sending ? null : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeTender")}
                    onClick={() => onPayment((p) => removePaymentTender(p, index))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {submit.kind === "unknown" ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/50 p-3 text-sm">
          <p className="font-medium">{t("unknownTitle")}</p>
          <p>{t("unknownBody")}</p>
          <Button onClick={retry}>{t("retry")}</Button>
        </div>
      ) : null}
      {submit.kind === "error" ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submit.message}
        </p>
      ) : null}

      {settled && !unknownOnly ? (
        <div className="space-y-3 text-center">
          {totalChange > 0n ? (
            <div className="rounded-lg bg-success/15 px-3 py-3" aria-live="polite">
              <p className="text-sm">{t("changeDue")}</p>
              <p className="text-4xl font-bold tabular-nums" data-testid="change-due">
                {format.money(totalChange)}
              </p>
            </div>
          ) : null}
          <Button
            size="xl"
            className="w-full"
            disabled={sending || submit.kind === "unknown"}
            onClick={complete}
          >
            {sending ? (
              <>
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                {t("sending")}
              </>
            ) : (
              t("complete")
            )}
          </Button>
        </div>
      ) : unknownOnly ? null : (
        <>
          <div
            role="radiogroup"
            aria-label={t("methodLabel")}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {METHODS.map(({ method: m, icon: Icon }) => (
              <Button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                variant={method === m ? "default" : "outline"}
                disabled={sending || awaiting || tenders.length >= MAX_TENDERS}
                onClick={() => setMethod(m)}
              >
                <Icon aria-hidden /> {t(`method.${m}`)}
              </Button>
            ))}
          </div>

          {method === "CASH" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2" aria-label={t("quickAmounts")} role="group">
                {quickCashAmounts(remaining).map((amount) => (
                  <Button
                    key={amount.toString()}
                    variant="secondary"
                    className="tabular-nums"
                    onClick={() => addCash(amount)}
                  >
                    {format.money(amount)}
                  </Button>
                ))}
              </div>
              <KeypadField
                value={text}
                onChange={(next) => {
                  setText(next);
                  setFieldError(null);
                }}
                label={t("cashGiven")}
                suffix="₮"
                decimals={decimals}
                invalid={fieldError !== null}
                describedBy={fieldError ? errId : undefined}
                onEnter={() => addCash(typed)}
              />
              {changeDue > 0n ? (
                <p className="text-center text-2xl font-bold" aria-live="polite">
                  {t("changeDue")}:{" "}
                  <span data-testid="change-preview">{format.money(changeDue)}</span>
                </p>
              ) : null}
              <Button
                className="w-full"
                size="lg"
                disabled={typed === null || typed <= 0n}
                onClick={() => addCash(typed)}
              >
                {typed !== null && typed < remaining ? t("addPartial") : t("addCash")}
              </Button>
            </div>
          ) : method === "QPAY" ? (
            <QpayPanel
              key={payment.invoice?.invoice.intentId ?? `${remaining}`}
              saleId={saleId}
              amount={remaining}
              initial={payment.invoice}
              onInvoice={(invoice) => onPayment((p) => setPaymentInvoice(p, invoice))}
              onPaid={(intentId, amount) =>
                onPayment((p) =>
                  addPaymentTender(
                    setPaymentInvoice(p, null),
                    { method: "QPAY", amount, paymentIntentId: intentId },
                    payable,
                  ),
                )
              }
            />
          ) : (
            <div className="space-y-3">
              <KeypadField
                value={text}
                onChange={(next) => {
                  setText(next);
                  setFieldError(null);
                }}
                label={t("amount")}
                suffix="₮"
                decimals={decimals}
                invalid={fieldError !== null}
                describedBy={fieldError ? errId : undefined}
                onEnter={addOther}
              />
              <div className="space-y-2">
                <Label htmlFor={refId}>
                  {method === "BANK_TRANSFER" ? t("referenceRequired") : t("referenceOptional")}
                </Label>
                <Input
                  id={refId}
                  value={reference}
                  maxLength={100}
                  onChange={(event) => setReference(event.target.value)}
                />
              </div>
              <Button className="w-full" size="lg" onClick={addOther}>
                {t("addPayment")}
              </Button>
            </div>
          )}
          {fieldError ? (
            <p id={errId} role="alert" className="text-sm text-destructive">
              {fieldError}
            </p>
          ) : null}
        </>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={sending || awaiting}>
          {t("back")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}
