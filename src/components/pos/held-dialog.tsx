"use client";

import { Play, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { computeTotals } from "@/domain/cart";
import { snapshotOf, indexEntries } from "@/lib/pos/catalog-entry";
import type { HeldCart } from "@/lib/pos/hold-storage";
import { PosDialog } from "./pos-dialog";
import { useFormat } from "./use-format";

function ageText(ms: number, t: ReturnType<typeof useTranslations<"pos.held">>): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hoursAgo", { count: hours });
  return t("daysAgo", { count: Math.floor(hours / 24) });
}

/** Parked carts of this cashier on this register: resume or discard. */
export function HeldDialog({
  open,
  onClose,
  held,
  now,
  totalRoundingUnit,
  onResume,
  onDiscard,
}: {
  open: boolean;
  onClose: () => void;
  held: readonly HeldCart[];
  now: number;
  totalRoundingUnit: bigint;
  onResume: (cart: HeldCart) => void;
  onDiscard: (cart: HeldCart) => void;
}) {
  const t = useTranslations("pos.held");
  const format = useFormat();
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <PosDialog open={open} onClose={onClose} title={t("title")} description={t("description")}>
      {held.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul
          className="max-h-[50dvh] divide-y overflow-y-auto rounded-md border"
          data-testid="held-list"
        >
          {[...held].reverse().map((cart) => {
            const lines = cart.cart.lines.filter((l) => !l.voided);
            let total = "";
            try {
              total = format.money(
                computeTotals(cart.cart, snapshotOf(indexEntries(cart.entries)), {
                  totalRoundingUnit,
                }).payable,
              );
            } catch {
              total = "—";
            }
            return (
              <li key={cart.saleId} className="space-y-2 px-3 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {t("items", { count: lines.length })}
                    <span className="text-muted-foreground">
                      {" "}
                      · {ageText(now - cart.heldAt, t)}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{total}</span>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {lines
                    .slice(0, 3)
                    .map((l) => cart.entries.find((e) => e.variantId === l.variantId)?.label ?? "")
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={() => onResume(cart)}>
                    <Play aria-hidden /> {t("resume")}
                  </Button>
                  {confirming === cart.saleId ? (
                    <Button variant="destructive" onClick={() => onDiscard(cart)}>
                      {t("confirmDiscard")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      aria-label={t("discard")}
                      onClick={() => setConfirming(cart.saleId)}
                    >
                      <Trash2 aria-hidden />{" "}
                      <span className="hidden sm:inline">{t("discard")}</span>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}
