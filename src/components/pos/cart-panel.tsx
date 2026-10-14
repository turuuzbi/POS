"use client";

import {
  ArrowLeft,
  Ban,
  MessageSquare,
  Minus,
  MoreVertical,
  Pause,
  Percent,
  Plus,
  ReceiptText,
  ShieldAlert,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CartLine } from "@/domain/cart";
import type { SaleTotals } from "@/domain/cart";
import { isFractionalUnit, MILLI_PER_UNIT } from "@/domain/qty";
import type { PosState } from "@/lib/pos/pos-state";
import { cn } from "@/lib/utils";
import { useFormat, type Format } from "./use-format";

export interface CartHandlers {
  onStep: (lineId: string, deltaMilli: number) => void;
  onEditQty: (lineId: string) => void;
  onPrice: (lineId: string) => void;
  onLineDiscount: (lineId: string) => void;
  onNote: (lineId: string) => void;
  onVoid: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onCartDiscount: () => void;
  onClear: () => void;
  onHold: () => void;
  onHeld: () => void;
  onApprove: () => void;
  onCharge: () => void;
  onClose: () => void;
}

function LineRow({
  line,
  state,
  totals,
  needsApproval,
  format,
  handlers,
}: {
  line: CartLine;
  state: PosState;
  totals: SaleTotals["lines"][number] | undefined;
  needsApproval: boolean;
  format: Format;
  handlers: CartHandlers;
}) {
  const t = useTranslations("pos.cart");
  const entry = state.entries[line.variantId];
  const unit = entry?.unit ?? "PIECE";
  const fractional = isFractionalUnit(unit);
  const name = entry?.label ?? line.variantId;
  const price = line.priceOverride ?? line.unitPrice;
  const hasDiscount = (totals?.discount ?? 0n) > 0n;
  const showOriginal =
    hasDiscount || (line.priceOverride !== undefined && line.priceOverride !== line.unitPrice);
  const qtyText = `${format.qty(line.qtyMilli, unit)} ${format.unit(unit)}`;

  return (
    <li
      data-testid="cart-line"
      data-voided={line.voided ? "true" : undefined}
      className={cn("space-y-2 border-b px-3 py-3 last:border-b-0", line.voided && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("font-medium break-words", line.voided && "line-through")}>{name}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {format.money(price)} × {qtyText}
          </p>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          {line.voided ? (
            <Badge variant="outline">{t("voided")}</Badge>
          ) : (
            <>
              <p className="font-semibold" data-testid="line-total">
                {format.money(totals?.gross ?? 0n)}
              </p>
              {showOriginal && totals ? (
                <p className="text-xs text-muted-foreground line-through">
                  {format.money(totals.subtotal)}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      {line.priceOverride !== undefined ||
      line.discounts.length > 0 ||
      line.note ||
      needsApproval ? (
        <div className="flex flex-wrap gap-1">
          {line.priceOverride !== undefined ? (
            <Badge variant="secondary">
              <Tag aria-hidden /> {t("priceChanged")}
            </Badge>
          ) : null}
          {line.discounts.map((d, i) => (
            <Badge key={i} variant="secondary">
              <Percent aria-hidden />
              {d.kind === "PERCENT" ? `${d.percentBps / 100}%` : format.money(d.amount)}
            </Badge>
          ))}
          {line.note ? (
            <Badge variant="outline" className="max-w-full truncate">
              <MessageSquare aria-hidden /> {line.note}
            </Badge>
          ) : null}
          {needsApproval ? (
            <Badge variant="destructive">
              <ShieldAlert aria-hidden /> {t("needsApproval")}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        {line.voided ? (
          <Button variant="outline" onClick={() => handlers.onRemove(line.lineId)}>
            <Trash2 aria-hidden /> {t("removeLine")}
          </Button>
        ) : (
          <>
            {fractional ? null : (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("decrease", { name })}
                onClick={() => handlers.onStep(line.lineId, -MILLI_PER_UNIT)}
              >
                <Minus aria-hidden />
              </Button>
            )}
            <Button
              variant="outline"
              className="min-w-16 tabular-nums"
              aria-label={t("editQty", { name, qty: qtyText })}
              onClick={() => handlers.onEditQty(line.lineId)}
            >
              {fractional ? qtyText : format.qty(line.qtyMilli, unit)}
            </Button>
            {fractional ? null : (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("increase", { name })}
                onClick={() => handlers.onStep(line.lineId, MILLI_PER_UNIT)}
              >
                <Plus aria-hidden />
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("lineActions", { name })}>
                    <MoreVertical aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem
                    className="min-h-11"
                    onSelect={() => handlers.onPrice(line.lineId)}
                  >
                    <Tag aria-hidden /> {t("changePrice")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    onSelect={() => handlers.onLineDiscount(line.lineId)}
                  >
                    <Percent aria-hidden /> {t("discount")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    onSelect={() => handlers.onNote(line.lineId)}
                  >
                    <MessageSquare aria-hidden /> {t("note")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-11"
                    onSelect={() => handlers.onVoid(line.lineId)}
                  >
                    <Ban aria-hidden /> {t("void")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("remove", { name })}
                onClick={() => handlers.onRemove(line.lineId)}
              >
                <X aria-hidden />
              </Button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

function TotalRow({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "font-semibold")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function CartPanel({
  state,
  totals,
  pendingKeys,
  heldCount,
  offline,
  charging,
  handlers,
  className,
}: {
  state: PosState;
  totals: SaleTotals;
  pendingKeys: ReadonlySet<string>;
  heldCount: number;
  offline: boolean;
  charging: boolean;
  handlers: CartHandlers;
  className?: string;
}) {
  const t = useTranslations("pos.cart");
  const format = useFormat();
  const active = state.cart.lines.filter((l) => !l.voided);
  const empty = active.length === 0;
  const totalsByLine = new Map(totals.lines.map((l) => [l.lineId, l]));
  const pendingCount = pendingKeys.size;
  const itemCount = active.length;
  const chargeBlocked = empty || offline || charging;

  return (
    <section
      aria-label={t("title")}
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={t("backToItems")}
          onClick={handlers.onClose}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <Badge variant="secondary" aria-label={t("itemCount", { count: itemCount })}>
          {itemCount}
        </Badge>
        <Button
          variant="outline"
          className="ml-auto"
          aria-keyshortcuts="F4"
          onClick={handlers.onHeld}
        >
          <Pause aria-hidden /> {t("held", { count: heldCount })}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="cart-lines">
        {empty && state.cart.lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-muted-foreground">
            <ReceiptText className="size-8" aria-hidden />
            <p className="font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="text-sm">{t("emptyHint")}</p>
          </div>
        ) : (
          <ul aria-label={t("lines")}>
            {state.cart.lines.map((line) => (
              <LineRow
                key={line.lineId}
                line={line}
                state={state}
                totals={totalsByLine.get(line.lineId)}
                needsApproval={[...pendingKeys].some((k) => k.startsWith(`line:${line.lineId}:`))}
                format={format}
                handlers={handlers}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
        {state.cart.discounts.length > 0 ? (
          <div className="flex flex-wrap gap-1" aria-label={t("cartDiscounts")}>
            {state.cart.discounts.map((d, i) => (
              <Badge key={i} variant="secondary">
                <Percent aria-hidden />
                {t("cartDiscountBadge", {
                  value: d.kind === "PERCENT" ? `${d.percentBps / 100}%` : format.money(d.amount),
                })}
              </Badge>
            ))}
          </div>
        ) : null}
        <dl className="space-y-1 text-sm">
          <TotalRow
            label={t("subtotal")}
            value={format.money(totals.subtotal)}
            testId="total-subtotal"
          />
          {totals.discountTotal > 0n ? (
            <TotalRow
              label={t("discounts")}
              value={`-${format.money(totals.discountTotal)}`}
              testId="total-discount"
            />
          ) : null}
          <TotalRow label={t("vat")} value={format.money(totals.vatTotal)} testId="total-vat" />
          {totals.cityTotal > 0n ? (
            <TotalRow
              label={t("cityTax")}
              value={format.money(totals.cityTotal)}
              testId="total-city"
            />
          ) : null}
          {totals.roundingAmount !== 0n ? (
            <TotalRow
              label={t("rounding")}
              value={format.money(totals.roundingAmount)}
              testId="total-rounding"
            />
          ) : null}
        </dl>
        <div
          className="flex items-baseline justify-between gap-3 border-t pt-2"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="text-base font-semibold">{t("payable")}</span>
          <span className="text-3xl font-bold tabular-nums" data-testid="total-payable">
            {format.money(totals.payable)}
          </span>
        </div>

        {pendingCount > 0 ? (
          <div
            role="status"
            className="flex items-center justify-between gap-2 rounded-md bg-warning/20 px-3 py-2 text-sm"
          >
            <span>{t("pendingApprovals", { count: pendingCount })}</span>
            <Button size="sm" variant="outline" onClick={handlers.onApprove}>
              <ShieldAlert aria-hidden /> {t("approve")}
            </Button>
          </div>
        ) : null}
        {offline ? (
          <p role="status" className="text-sm text-destructive">
            {t("offlineCharge")}
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            disabled={empty}
            aria-keyshortcuts="F3"
            onClick={handlers.onHold}
          >
            <Pause aria-hidden /> {t("hold")}
          </Button>
          <Button
            variant="outline"
            disabled={empty}
            aria-keyshortcuts="F8"
            onClick={handlers.onCartDiscount}
          >
            <Percent aria-hidden /> {t("cartDiscount")}
          </Button>
          <Button
            variant="outline"
            disabled={state.cart.lines.length === 0}
            onClick={handlers.onClear}
          >
            <Trash2 aria-hidden /> {t("clear")}
          </Button>
        </div>
        <Button
          size="xl"
          className="w-full"
          disabled={chargeBlocked}
          aria-keyshortcuts="F2"
          onClick={handlers.onCharge}
        >
          {t("charge")} · {format.money(totals.payable)}
        </Button>
      </div>
    </section>
  );
}
