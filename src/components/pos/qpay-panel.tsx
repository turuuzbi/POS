"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Money } from "@/domain/money";
import type { QpayInvoice } from "@/domain/qpay";
import { qpayPollDelay } from "@/lib/pos/charge";
import { moneyToInput } from "@/lib/pos/money-input";
import { checkQpayAction, createQpayInvoiceAction } from "@/server/actions/payments";
import { useFormat } from "./use-format";

type Phase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "waiting"; invoice: QpayInvoice; qr: string | null }
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
  onPaid,
}: {
  saleId: string;
  amount: Money;
  /** The invoice is PAID: the intent id goes into the tender. */
  onPaid: (intentId: string) => void;
}) {
  const t = useTranslations("pos.qpay");
  const format = useFormat();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const run = useRef(0); // bumps to cancel the polling loop of an older invoice
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  });

  useEffect(() => {
    const token = run;
    return () => {
      token.current++; // stop polling when the panel goes away
    };
  }, []);

  const poll = useCallback(async (invoice: QpayInvoice, mine: number) => {
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
            onPaidRef.current(invoice.intentId);
            return;
          }
          if (status === "EXPIRED" || status === "FAILED" || status === "CANCELLED") {
            setPhase({ kind: "ended", reason: status });
            return;
          }
        }
      } catch {
        // transient network error: keep polling
      }
      if (Date.now() > deadline + 5000) {
        setPhase({ kind: "ended", reason: "EXPIRED" });
        return;
      }
    }
  }, []);

  const start = async () => {
    const mine = ++run.current;
    setPhase({ kind: "creating" });
    try {
      const result = await createQpayInvoiceAction({ saleId, amount: moneyToInput(amount) });
      if (run.current !== mine) return;
      if (!result.ok) {
        setPhase({ kind: "error" });
        return;
      }
      const invoice = result.data;
      let qr: string | null = null;
      try {
        const qrcode = await import("qrcode");
        qr = await qrcode.toDataURL(invoice.qrText, {
          margin: 1,
          width: 256,
          errorCorrectionLevel: "M",
        });
      } catch {
        qr = null;
      }
      if (run.current !== mine) return;
      setPhase({ kind: "waiting", invoice, qr });
      void poll(invoice, mine);
    } catch {
      if (run.current === mine) setPhase({ kind: "error" });
    }
  };

  const cancel = () => {
    run.current++;
    setPhase({ kind: "ended", reason: "CANCELLED" });
  };

  if (phase.kind === "waiting") {
    const { invoice, qr } = phase;
    return (
      <div className="space-y-3 text-center" data-testid="qpay-waiting">
        <p className="text-sm text-muted-foreground">
          {t("scan", { amount: format.money(amount) })}
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
