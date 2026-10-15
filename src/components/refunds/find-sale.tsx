"use client";

import { Camera, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CameraDialog } from "@/components/pos/camera-dialog";
import { useFormat } from "@/components/pos/use-format";
import { SaleStateBadge, useDateTime } from "@/components/refunds/sale-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseReceiptInput, normaliseSearch } from "@/lib/refunds/receipt-input";
import {
  recentSalesResultSchema,
  returnLookupResultSchema,
  type RecentSale,
  type ReturnLookupResult,
} from "@/lib/refunds/sale-wire";
import { voidBlockForRow, VOID_BLOCK_KEY } from "@/lib/refunds/void";
import { cn } from "@/lib/utils";
import { findReturnSaleAction, listRecentSalesAction } from "@/server/actions/refund-lookup";

export type Intent = "RETURN" | "VOID";

type Lookup = { kind: "idle" } | { kind: "busy" } | { kind: "notFound" } | { kind: "failed" };

type Recent =
  | { kind: "loading"; sales: RecentSale[]; truncated: boolean }
  | { kind: "ready"; sales: RecentSale[]; truncated: boolean }
  | { kind: "failed"; sales: RecentSale[]; truncated: boolean };

/** Resolve typed/scanned text (or a sale id) to the full sale. */
export async function lookupSale(
  text: string,
): Promise<
  { kind: "found"; result: ReturnLookupResult } | { kind: "notFound" } | { kind: "failed" }
> {
  try {
    const response = await findReturnSaleAction({ text });
    if (!response.ok) return { kind: "failed" };
    const parsed = returnLookupResultSchema.safeParse(response.data);
    if (!parsed.success) return { kind: "failed" };
    return parsed.data.sale ? { kind: "found", result: parsed.data } : { kind: "notFound" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Find the sale to return: a receipt number typed or scanned (a USB scanner
 * types into the focused box and presses Enter; the camera is the fallback),
 * or pick one of the register's recent sales, searchable by number.
 */
export function FindSale({
  currentShiftId,
  onOpen,
}: {
  currentShiftId: string | null;
  onOpen: (result: ReturnLookupResult, intent: Intent) => void;
}) {
  const t = useTranslations("refunds.find");
  const tb = useTranslations("refunds.void.blocked");
  const format = useFormat();
  const dateTime = useDateTime();
  const inputId = useId();
  const searchId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  const [camera, setCamera] = useState(false);
  const [scope, setScope] = useState<"SHIFT" | "REGISTER">(currentShiftId ? "SHIFT" : "REGISTER");
  const [search, setSearch] = useState("");
  const [recent, setRecent] = useState<Recent>({ kind: "loading", sales: [], truncated: false });
  const [opening, setOpening] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const open = useCallback(
    async (query: string, intent: Intent): Promise<boolean> => {
      const outcome = await lookupSale(query);
      if (outcome.kind === "found") {
        onOpen(outcome.result, intent);
        return true;
      }
      setLookup({ kind: outcome.kind });
      return false;
    },
    [onOpen],
  );

  const submit = async () => {
    if (lookup.kind === "busy") return;
    const key = parseReceiptInput(text);
    if (!key) {
      setLookup({ kind: "notFound" });
      return;
    }
    setLookup({ kind: "busy" });
    const found = await open(text, "RETURN");
    if (!found) inputRef.current?.select();
  };

  // Recent sales: reload when the scope or the (debounced) search changes.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        setRecent((current) => ({ ...current, kind: "loading" }));
        try {
          const response = await listRecentSalesAction({ scope, query: search });
          if (cancelled) return;
          const parsed = response.ok ? recentSalesResultSchema.safeParse(response.data) : null;
          if (parsed?.success) setRecent({ kind: "ready", ...parsed.data });
          else setRecent((current) => ({ ...current, kind: "failed" }));
        } catch {
          if (!cancelled) setRecent((current) => ({ ...current, kind: "failed" }));
        }
      },
      search ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, search, reloadTick]);

  const openRow = async (row: RecentSale, intent: Intent) => {
    if (opening) return;
    setOpening(`${row.id}:${intent}`);
    const found = await open(row.id, intent);
    if (!found) setOpening(null);
  };

  return (
    <div className="space-y-5">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId} className="text-sm font-medium">
          {t("label")}
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={inputId}
              ref={inputRef}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={text}
              placeholder={t("placeholder")}
              aria-invalid={
                lookup.kind === "notFound" || lookup.kind === "failed" ? true : undefined
              }
              aria-describedby={
                lookup.kind === "notFound" || lookup.kind === "failed" ? errorId : undefined
              }
              className="h-12 pl-9 text-base"
              onChange={(event) => {
                setText(event.target.value);
                if (lookup.kind !== "busy") setLookup({ kind: "idle" });
              }}
              data-testid="receipt-input"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-12"
            aria-label={t("camera")}
            onClick={() => setCamera(true)}
          >
            <Camera aria-hidden />
          </Button>
          <Button
            type="submit"
            size="lg"
            disabled={!text.trim() || lookup.kind === "busy"}
            data-testid="receipt-find"
          >
            {lookup.kind === "busy" ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : null}
            {t("find")}
          </Button>
        </div>
        <p
          className="min-h-5 text-sm"
          id={errorId}
          role={lookup.kind === "idle" ? undefined : "alert"}
        >
          {lookup.kind === "notFound" ? (
            <span className="text-destructive">{t("notFound")}</span>
          ) : lookup.kind === "failed" ? (
            <span className="text-destructive">{t("failed")}</span>
          ) : (
            <span className="text-muted-foreground">{t("hint")}</span>
          )}
        </p>
      </form>

      <section className="space-y-3" aria-labelledby={`${searchId}-title`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${searchId}-title`} className="text-base font-semibold">
            {t("recentTitle")}
          </h3>
          <div role="radiogroup" aria-label={t("scopeLabel")} className="flex gap-1">
            {(["SHIFT", "REGISTER"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                variant={scope === value ? "default" : "outline"}
                className="min-h-11"
                onClick={() => setScope(value)}
                data-testid={`recent-scope-${value}`}
              >
                {t(`scope.${value}`)}
              </Button>
            ))}
          </div>
        </div>
        <Input
          id={searchId}
          type="search"
          autoComplete="off"
          aria-label={t("searchLabel")}
          placeholder={t("searchPlaceholder")}
          value={search}
          className="h-11"
          onChange={(event) => setSearch(normaliseSearch(event.target.value))}
          data-testid="recent-search"
        />

        <div aria-busy={recent.kind === "loading"} className="min-h-40">
          {recent.sales.length === 0 && recent.kind === "ready" ? (
            <p
              className="py-8 text-center text-sm text-muted-foreground"
              data-testid="recent-empty"
            >
              {search ? t("noMatches") : scope === "SHIFT" ? t("emptyShift") : t("empty")}
            </p>
          ) : null}
          {recent.kind === "failed" ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <span>{t("loadFailed")}</span>
              <Button type="button" variant="outline" onClick={() => setReloadTick((n) => n + 1)}>
                {t("retry")}
              </Button>
            </div>
          ) : null}
          <ul
            className={cn("space-y-2", recent.kind === "loading" && "opacity-60")}
            data-testid="recent-sales"
          >
            {recent.sales.map((row) => {
              const block = voidBlockForRow(row, currentShiftId);
              const returnable = row.state === "OK" || row.state === "PARTIALLY_REFUNDED";
              return (
                <li
                  key={row.id}
                  data-testid="recent-sale"
                  data-number={row.number}
                  className="space-y-2 rounded-lg border bg-background p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-semibold tabular-nums">
                        {row.number}
                        <SaleStateBadge state={row.state} />
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {dateTime(row.occurredAt)} · {t("items", { count: row.lineCount })}
                      </p>
                    </div>
                    <p className="font-semibold tabular-nums">{format.money(row.totalAmount)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={opening !== null || !returnable}
                      onClick={() => void openRow(row, "RETURN")}
                      aria-label={t("returnSale", { number: row.number })}
                    >
                      {opening === `${row.id}:RETURN` ? (
                        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                      ) : null}
                      {t("return")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={opening !== null || block !== null}
                      onClick={() => void openRow(row, "VOID")}
                      aria-label={t("voidSale", { number: row.number })}
                    >
                      {t("void")}
                    </Button>
                    {block !== null ? (
                      <p className="text-xs text-muted-foreground" data-testid="void-reason-note">
                        {tb(VOID_BLOCK_KEY[block])}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {recent.truncated ? (
            <p className="pt-2 text-center text-xs text-muted-foreground">{t("truncated")}</p>
          ) : null}
        </div>
      </section>

      {camera ? (
        <CameraDialog
          onClose={() => setCamera(false)}
          onDetect={async (code) => {
            const key = parseReceiptInput(code);
            if (!key) return false;
            const found = await open(code, "RETURN");
            if (found) setCamera(false);
            return found;
          }}
        />
      ) : null}
    </div>
  );
}
