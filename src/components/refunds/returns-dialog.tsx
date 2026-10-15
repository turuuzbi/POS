"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { PosDialog } from "@/components/pos/pos-dialog";
import { RefundDone, VoidDone } from "@/components/refunds/done-views";
import { FindSale, lookupSale, type Intent } from "@/components/refunds/find-sale";
import { SalePanel, type SaleMeta } from "@/components/refunds/sale-panel";
import { VoidPanel } from "@/components/refunds/void-panel";
import type { Role } from "@/domain/permissions";
import type { RefundResult } from "@/domain/refund-contract";
import type { VoidResult } from "@/domain/void-contract";
import type { ExchangeContext } from "@/lib/refunds/exchange";
import {
  resultFromStored,
  type ReturnLookupResult,
  type ReturnSale,
} from "@/lib/refunds/sale-wire";
import { cn } from "@/lib/utils";

type View =
  | { name: "find" }
  | { name: "sale"; sale: ReturnSale; meta: SaleMeta; mode: "RETURN" | "EXCHANGE"; epoch: number }
  | { name: "void"; sale: ReturnSale; meta: SaleMeta; epoch: number }
  | { name: "refunded"; result: RefundResult }
  | { name: "voided"; result: VoidResult };

/** Full screen on a phone, a large dialog on a tablet / desktop till. */
const SIZE =
  "max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0 max-sm:p-3 sm:max-w-3xl lg:max-w-5xl";

function metaOf(result: ReturnLookupResult): SaleMeta {
  return {
    maxRefundWindowDays: result.policy.maxRefundWindowDays,
    roundingUnit: result.roundingUnit,
  };
}

/**
 * The register's Returns screen: find the sale (typed / scanned receipt number
 * or the recent sales list), then return, exchange or void it. Everything the
 * cashier does is a preview of the server's own computation; nothing here is
 * authoritative.
 */
export function ReturnsDialog({
  onClose,
  role,
  currentShiftId,
  onStartExchange,
}: {
  onClose: () => void;
  role: Role;
  /** The register's open shift; voids are only possible for its sales. */
  currentShiftId: string | null;
  onStartExchange: (context: ExchangeContext, sale: ReturnSale, meta: SaleMeta) => void;
}) {
  const t = useTranslations("refunds");
  const [view, setView] = useState<View>({ name: "find" });
  const [busy, setBusy] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);

  const title =
    view.name === "find"
      ? t("title")
      : view.name === "sale"
        ? t("sale.title", { number: view.sale.number })
        : view.name === "void"
          ? t("void.title", { number: view.sale.number })
          : view.name === "refunded"
            ? t("done.title")
            : t("voidDone.title");
  const description =
    view.name === "find"
      ? t("description")
      : view.name === "sale"
        ? t("sale.description")
        : view.name === "void"
          ? t("void.description")
          : undefined;

  const openSale = (result: ReturnLookupResult, intent: Intent) => {
    if (!result.sale) return;
    const meta = metaOf(result);
    setView(
      intent === "VOID"
        ? { name: "void", sale: result.sale, meta, epoch: Date.now() }
        : { name: "sale", sale: result.sale, meta, mode: "RETURN", epoch: Date.now() },
    );
  };

  /** Re-read the sale: after a stale answer, or to learn whether an unknown outcome committed. */
  const reload = async (
    sale: ReturnSale,
    check: { refundId: string | null; voided: boolean },
    next: "sale" | "void",
  ) => {
    setReloadFailed(false);
    const outcome = await lookupSale(sale.id);
    if (outcome.kind !== "found" || !outcome.result.sale) {
      setReloadFailed(true);
      return;
    }
    const fresh = outcome.result.sale;
    if (check.refundId) {
      const stored = resultFromStored(fresh, check.refundId);
      if (stored) {
        setBusy(false);
        setView({ name: "refunded", result: stored });
        return;
      }
    }
    if (check.voided && fresh.status === "VOIDED") {
      setBusy(false);
      setView({
        name: "voided",
        result: {
          saleId: fresh.id,
          receiptNumber: fresh.number,
          totalAmount: fresh.totalAmount,
          cashReturned: fresh.payments
            .filter((p) => p.method === "CASH")
            .reduce((acc, p) => acc + p.amount, 0n),
          replayed: true,
        },
      });
      return;
    }
    // A new epoch remounts the panel: fresh remaining quantities and a fresh refund id.
    setBusy(false);
    const meta = metaOf(outcome.result);
    setView(
      next === "void"
        ? { name: "void", sale: fresh, meta, epoch: Date.now() }
        : { name: "sale", sale: fresh, meta, mode: "RETURN", epoch: Date.now() },
    );
  };

  return (
    <PosDialog
      open
      onClose={onClose}
      title={title}
      description={description}
      locked={busy}
      className={cn(SIZE)}
    >
      {reloadFailed ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("panel.reloadFailed")}
        </p>
      ) : null}

      {view.name === "find" ? <FindSale currentShiftId={currentShiftId} onOpen={openSale} /> : null}

      {view.name === "sale" ? (
        <SalePanel
          key={`${view.sale.id}:${view.epoch}`}
          sale={view.sale}
          meta={view.meta}
          role={role}
          currentShiftId={currentShiftId}
          initialMode={view.mode}
          onBack={() => setView({ name: "find" })}
          onVoid={() =>
            setView({ name: "void", sale: view.sale, meta: view.meta, epoch: Date.now() })
          }
          onDone={(result) => setView({ name: "refunded", result })}
          onReload={(refundId) => void reload(view.sale, { refundId, voided: false }, "sale")}
          onStartExchange={(context) => onStartExchange(context, view.sale, view.meta)}
          onBusy={setBusy}
        />
      ) : null}

      {view.name === "void" ? (
        <VoidPanel
          key={`${view.sale.id}:${view.epoch}`}
          sale={view.sale}
          role={role}
          currentShiftId={currentShiftId}
          onBack={() => setView({ name: "find" })}
          onDone={(result) => setView({ name: "voided", result })}
          onReload={(voided) => void reload(view.sale, { refundId: null, voided }, "void")}
          onBusy={setBusy}
        />
      ) : null}

      {view.name === "refunded" ? (
        <RefundDone
          result={view.result}
          onAnother={() => setView({ name: "find" })}
          onClose={onClose}
        />
      ) : null}
      {view.name === "voided" ? (
        <VoidDone
          result={view.result}
          onAnother={() => setView({ name: "find" })}
          onClose={onClose}
        />
      ) : null}
    </PosDialog>
  );
}
