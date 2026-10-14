"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Money } from "@/domain/money";
import type { QpayInvoice } from "@/domain/qpay";
import { qpayPollDelay } from "@/lib/pos/charge";
import type { PendingInvoice } from "@/lib/pos/payment-state";
import { moneyToInput } from "@/lib/pos/money-input";
import { checkQpayAction, createQpayInvoiceAction } from "@/server/actions/payments";
import { useFormat } from "./use-format";

type Phase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "waiting"; invoice: QpayInvoice; amount: Money; qr: string | null }
  | { kind: "ended"; reason: "EXPIRED" | "FAILED" | "CANCELLED" }
  | { kind: "error" };

/**
 * QPay: ask the server for an invoice, show its QR and poll the server-side
 * status check (with backoff) until PAID or the invoice ends. The server
 * verifies with the provider; nothing here is trusted as proof of payment.
 */
export function QpayPanel({
  saleId,
  amount,
  initial,
  onInvoice,
  onPaid,
}: {
  saleId: string;
  amount: Money;
  /** An invoice created earlier (kept by the register): shown and polled again. */
  initial: PendingInvoice | null;
  /** The register keeps the open invoice (null once it ended or was cancelled). */
  onInvoice: (invoice: PendingInvoice | null) => void;
  /** The invoice is PAID: the intent id and what it covers go into the tender. */
  onPaid: (intentId: string, amount: Money) => void;
}) {
  const t = useTranslations("pos.qpay");
  const format = useFormat();
  const [phase, setPhase] = useState<Phase>(
    initial
      ? { kind: "waiting", invoice: initial.invoice, amount: initial.amount, qr: null }
      : { kind: "idle" },
  );
  const run = useRef(0); // bumps to cancel the polling loop of an older invoice
  const onPaidRef = useRef(onPaid);
  const onInvoiceRef = useRef(onInvoice);
  useEffect(() => {
    onPaidRef.current = onPaid;
    onInvoiceRef.current = onInvoice;
  });

  useEffect(() => {
    const token = run;
    return () => {
      token.current++; // stop polling when the panel goes away
    };
  }, []);

  const poll = useCallback(async (invoice: QpayInvoice, invoiceAmount: Money, mine: number) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = invoice.expiresAt ? Date.parse(invoice.expiresAt) : Number.POSITIVE_INFINITY;
    for (let attempt = 0; ; attempt++) {
      await sleep(qpayPollDelay(attempt));
      if (run.current !== mine) return;
      try {
        const result = await checkQpayAction({ intentId: invoice.intentId });
        if (run.current !== mine) return;
        if (result.ok) {
          const status = result.data.status;
          if (status === "PAID") {
            onPaidRef.current(invoice.intentId, invoiceAmount);
            return;
          }
          if (status === "EXPIRED" || status === "FAILED" || status === "CANCELLED") {
            onInvoiceRef.current(null);
            setPhase({ kind: "ended", reason: status });
            return;
          }
        }
      } catch {
        // transient network error: keep polling
      }
      if (Date.now() > deadline + 5000) {
        onInvoiceRef.current(null);
        setPhase({ kind: "ended", reason: "EXPIRED" });
        return;
      }
    }
  }, []);

  const qrFor = async (invoice: QpayInvoice): Promise<string | null> => {
    try {
      const qrcode = await import("qrcode");
      return await qrcode.toDataURL(invoice.qrText, {
        margin: 1,
        width: 256,
        errorCorrectionLevel: "M",
      });
    } catch {
      return null;
    }
  };

  // Reopened with an invoice that is still open: draw its QR and keep polling.
  useEffect(() => {
    if (!initial) return;
    const mine = ++run.current;
    void (async () => {
      const qr = await qrFor(initial.invoice);
      if (run.current !== mine) return;
      setPhase({ kind: "waiting", invoice: initial.invoice, amount: initial.amount, qr });
    })();
    void poll(initial.invoice, initial.amount, mine);
    // only the invoice this panel was opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    const mine = ++run.current;
    setPhase({ kind: "creating" });
    try {
      const result = await createQpayInvoiceAction({ saleId, amount: moneyToInput(amount) });
      if (!result.ok) {
        if (run.current === mine) setPhase({ kind: "error" });
        return;
      }
      const invoice = result.data;
      // Keep the invoice even if this panel went away meanwhile: a payment made
      // against it must always be found again.
      onInvoiceRef.current({ invoice, amount });
      if (run.current !== mine) return;
      const qr = await qrFor(invoice);
      if (run.current !== mine) return;
      setPhase({ kind: "waiting", invoice, amount, qr });
      void poll(invoice, amount, mine);
    } catch {
      if (run.current === mine) setPhase({ kind: "error" });
    }
  };

  const cancel = () => {
    run.current++;
    onInvoiceRef.current(null);
    setPhase({ kind: "ended", reason: "CANCELLED" });
  };

  if (phase.kind === "waiting") {
    const { invoice, qr } = phase;
    const shown = phase.amount;
    return (
      <div className="space-y-3 text-center" data-testid="qpay-waiting">
        <p className="text-sm text-muted-foreground">
          {t("scan", { amount: format.money(shown) })}
        </p>
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt={t("qrAlt")}
            width={256}
            height={256}
            className="mx-auto rounded-lg border bg-white p-2"
          />
        ) : (
          <p className="font-mono text-xs break-all">{invoice.qrText}</p>
        )}
        {invoice.deeplinks.length > 0 ? (
          <ul className="flex flex-wrap justify-center gap-2" aria-label={t("bankApps")}>
            {invoice.deeplinks.slice(0, 8).map((link) => (
              <li key={link.name}>
                <a
                  href={link.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm underline-offset-4 hover:underline"
                >
                  {link.name}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p role="status" className="flex items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {t("waiting")}
        </p>
        <Button variant="outline" onClick={cancel}>
          {t("cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {phase.kind === "ended" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`ended.${phase.reason}`)}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {t("createFailed")}
        </p>
      ) : null}
      <Button
        className="w-full"
        size="lg"
        disabled={phase.kind === "creating"}
        onClick={() => void start()}
      >
        {phase.kind === "creating" ? (
          <>
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            {t("creating")}
          </>
        ) : (
          t("create", { amount: format.money(amount) })
        )}
      </Button>
    </div>
  );
}
