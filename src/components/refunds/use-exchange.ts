"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { lookupSale } from "@/components/refunds/find-sale";
import type { SaleMeta } from "@/components/refunds/sale-panel";
import type { Role } from "@/domain/permissions";
import type { Money } from "@/domain/money";
import {
  browserStore,
  loadExchange,
  saveExchange,
  type ExchangeContext,
} from "@/lib/refunds/exchange";
import { previewRefund, type Preview } from "@/lib/refunds/plan";
import type { ReturnSale } from "@/lib/refunds/sale-wire";

export interface ExchangeState {
  context: ExchangeContext;
  sale: ReturnSale | null;
  meta: SaleMeta | null;
  /** The original sale could not be re-read (after a reload); retry is offered. */
  loadFailed: boolean;
}

/**
 * The exchange in progress on this register (if any). The context survives a
 * reload (localStorage, per register + cashier); the original sale is
 * re-read from the server when it is not at hand.
 */
export function useExchange(scope: string, role: Role, payable: Money) {
  const [context, setContext] = useState<ExchangeContext | null>(null);
  const [remote, setRemote] = useState<{ sale: ReturnSale; meta: SaleMeta } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now] = useState(() => new Date());

  // localStorage is not there during SSR: restore after mount.
  useEffect(() => {
    // Restoring persisted state after mount is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContext(loadExchange(browserStore(), scope));
  }, [scope]);

  const saleId = context?.saleId ?? null;
  const haveSale = remote?.sale.id === saleId;
  useEffect(() => {
    if (!saleId || haveSale) return;
    let cancelled = false;
    void lookupSale(saleId).then((outcome) => {
      if (cancelled) return;
      if (outcome.kind === "found" && outcome.result.sale) {
        setRemote({
          sale: outcome.result.sale,
          meta: {
            maxRefundWindowDays: outcome.result.policy.maxRefundWindowDays,
            roundingUnit: outcome.result.roundingUnit,
          },
        });
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [saleId, haveSale, attempt]);

  const persist = useCallback(
    (next: ExchangeContext | null) => {
      saveExchange(browserStore(), scope, next);
      setContext(next);
    },
    [scope],
  );

  const begin = useCallback(
    (next: ExchangeContext, sale: ReturnSale, meta: SaleMeta) => {
      setRemote({ sale, meta });
      setLoadFailed(false);
      persist(next);
    },
    [persist],
  );

  const payableNow = payable;
  const quote: Preview | null = useMemo(() => {
    if (!context || !remote || remote.sale.id !== context.saleId) return null;
    return previewRefund({
      refundId: context.refundId,
      sale: remote.sale,
      draft: context.draft,
      now,
      roundingUnit: remote.meta.roundingUnit,
      maxRefundWindowDays: remote.meta.maxRefundWindowDays,
      role,
      exchangeTotal: payableNow > 0n ? payableNow : undefined,
    });
  }, [context, remote, now, role, payableNow]);

  return {
    context,
    sale: haveSale ? (remote?.sale ?? null) : null,
    meta: haveSale ? (remote?.meta ?? null) : null,
    loadFailed,
    retryLoad: () => setAttempt((n) => n + 1),
    quote,
    payable: payableNow,
    begin,
    update: persist,
    clear: () => persist(null),
  };
}

export type ExchangeHandle = ReturnType<typeof useExchange>;
