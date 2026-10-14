"use client";

import { Check, Loader2, Minus, Plus, ScanBarcode, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { MILLI_PER_UNIT, formatQty, isFractionalUnit, parseQty, type Unit } from "@/domain/qty";
import { countStocktakeLineAction, scanStocktakeItemAction } from "@/server/actions/stocktakes";
import type { ScanHit } from "@/server/services/stocktakes";

export interface CountLine {
  variantId: string;
  label: string;
  sku: string | null;
  unit: Unit;
  countedMilli: number | null;
}

type Save = "idle" | "saving" | "saved" | "error";
type Filter = "all" | "counted" | "uncounted";

/** Editable text for a quantity: no digit grouping, up to 3 decimals. */
function toInput(milli: number | null): string {
  return milli === null ? "" : String(milli / MILLI_PER_UNIT);
}

/**
 * Count entry, built for a handheld scanner: the scan box keeps focus, a
 * scanned piece item is +1, a weighed item moves focus to its quantity.
 * Typed quantities autosave on blur/Enter; scans are queued so rapid
 * scanning never reorders. The expected quantity is deliberately hidden
 * (blind count); the review tab shows variances.
 */
export function CountScreen({
  stocktakeId,
  initialLines,
}: {
  stocktakeId: string;
  initialLines: CountLine[];
}) {
  const t = useTranslations("stocktakes");
  const te = useTranslations("errors");
  const locale = useLocale();
  const [lines, setLines] = useState(() => new Map(initialLines.map((l) => [l.variantId, l])));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saves, setSaves] = useState<Record<string, { state: Save; error?: string }>>({});
  const [feedback, setFeedback] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [choices, setChoices] = useState<ScanHit[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const rowInputs = useRef(new Map<string, HTMLInputElement>());

  const setSave = (variantId: string, state: Save, error?: string) =>
    setSaves((prev) => ({ ...prev, [variantId]: { state, error } }));

  const upsert = useCallback(
    (hit: Pick<CountLine, "variantId" | "label" | "sku" | "unit">, countedMilli: number | null) => {
      setLines((prev) => {
        const next = new Map(prev);
        next.set(hit.variantId, { ...hit, countedMilli });
        return next;
      });
      setDrafts((prev) => {
        const { [hit.variantId]: _dropped, ...rest } = prev;
        void _dropped;
        return rest;
      });
    },
    [],
  );

  const focusRow = (variantId: string) => {
    // Wait for the row to render, then focus its quantity field.
    requestAnimationFrame(() => {
      const input = rowInputs.current.get(variantId);
      input?.focus();
      input?.select();
      input?.scrollIntoView({ block: "center" });
    });
  };

  const call = useCallback(
    async <T,>(
      fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string } }>,
    ) => {
      try {
        return await fn();
      } catch {
        return { ok: false as const, error: { code: "INTERNAL" } };
      }
    },
    [],
  );

  const save = useCallback(
    async (line: CountLine, mode: "set" | "add" | "clear", qtyMilli?: number) => {
      setSave(line.variantId, "saving");
      const result = await call(() =>
        countStocktakeLineAction({ stocktakeId, variantId: line.variantId, mode, qtyMilli }),
      );
      if (result.ok) {
        upsert(line, result.data.countedMilli);
        setSave(line.variantId, "saved");
      } else {
        setSave(line.variantId, "error", te(result.error.code as never));
      }
    },
    [call, stocktakeId, te, upsert],
  );

  const handleScan = (code: string) => {
    queue.current = queue.current.then(async () => {
      const result = await call(() => scanStocktakeItemAction({ stocktakeId, code }));
      if (!result.ok) {
        setFeedback({ kind: "warn", text: te(result.error.code as never) });
        return;
      }
      const data = result.data;
      setChoices([]);
      if (data.kind === "none") {
        setFeedback({ kind: "warn", text: t("scanNone", { code }) });
      } else if (data.kind === "choose") {
        setChoices(data.hits);
        setFeedback({ kind: "ok", text: t("scanChoose") });
      } else if (data.kind === "counted") {
        upsert({ ...data.hit, unit: data.hit.unit }, data.countedMilli);
        setSave(data.hit.variantId, "saved");
        setFeedback({
          kind: "ok",
          text: t("scanCounted", {
            name: data.hit.label,
            qty: formatQty(data.countedMilli, data.hit.unit, { locale }),
          }),
        });
      } else {
        upsert(data.hit, data.countedMilli);
        setFeedback({ kind: "ok", text: t("scanEnter", { name: data.hit.label }) });
        focusRow(data.hit.variantId);
      }
    });
  };

  const pickChoice = (hit: ScanHit) => {
    setChoices([]);
    if (isFractionalUnit(hit.unit)) {
      const existing = lines.get(hit.variantId);
      upsert(hit, existing?.countedMilli ?? null);
      setFeedback({ kind: "ok", text: t("scanEnter", { name: hit.label }) });
      focusRow(hit.variantId);
      return;
    }
    const line: CountLine = {
      ...hit,
      countedMilli: lines.get(hit.variantId)?.countedMilli ?? null,
    };
    queue.current = queue.current.then(async () => {
      await save(line, "add", MILLI_PER_UNIT);
      setFeedback({ kind: "ok", text: t("scanCounted", { name: hit.label, qty: "+1" }) });
    });
  };

  const commit = (line: CountLine) => {
    const draft = drafts[line.variantId];
    if (draft === undefined) return;
    const text = draft.trim();
    if (text === "") {
      if (line.countedMilli !== null) void save(line, "clear");
      else setDrafts(({ [line.variantId]: _d, ...rest }) => (void _d, rest));
      return;
    }
    const qty = parseQty(text.replace(/^0+(?=\d)/, ""), line.unit);
    // parseQty rejects 0 (not a sale quantity) — a count of zero is valid here.
    const parsed = qty ?? (/^0+([.,]0{1,3})?$/.test(text) ? 0 : null);
    if (parsed === null) {
      setSave(line.variantId, "error", t("invalidQty"));
      return;
    }
    if (parsed === line.countedMilli) {
      setDrafts(({ [line.variantId]: _d, ...rest }) => (void _d, rest));
      return;
    }
    void save(line, "set", parsed);
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...lines.values()]
      .filter((l) => (filter === "counted" ? l.countedMilli !== null : true))
      .filter((l) => (filter === "uncounted" ? l.countedMilli === null : true))
      .filter(
        (l) =>
          !needle ||
          l.label.toLowerCase().includes(needle) ||
          (l.sku ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [lines, filter, search]);

  const counted = [...lines.values()].filter((l) => l.countedMilli !== null).length;

  return (
    <div className="space-y-4">
      <div className="sticky top-14 z-20 -mx-4 space-y-2 border-b bg-background/95 px-4 pt-2 pb-3 backdrop-blur sm:-mx-6 sm:px-6">
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            const input = scanRef.current;
            const code = input?.value.trim();
            if (!input || !code) return;
            input.value = "";
            handleScan(code);
          }}
        >
          <Label htmlFor="stocktake-scan">{t("scanLabel")}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <ScanBarcode
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="stocktake-scan"
                ref={scanRef}
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                maxLength={100}
                placeholder={t("scanPlaceholder")}
                aria-describedby="stocktake-scan-hint stocktake-scan-feedback"
                className="pl-10"
              />
            </div>
            <Button type="submit">
              <Plus aria-hidden />
              <span className="sr-only sm:not-sr-only">{t("scanLabel")}</span>
            </Button>
          </div>
          <p id="stocktake-scan-hint" className="text-xs text-muted-foreground">
            {t("scanHint")}
          </p>
        </form>
        <div id="stocktake-scan-feedback" role="status" aria-live="polite" className="min-h-5">
          {feedback ? (
            <p
              className={
                feedback.kind === "warn"
                  ? "flex items-center gap-1.5 text-sm font-medium text-destructive"
                  : "flex items-center gap-1.5 text-sm font-medium"
              }
            >
              {feedback.kind === "warn" ? (
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
              ) : (
                <Check className="size-4 shrink-0" aria-hidden />
              )}
              {feedback.text}
            </p>
          ) : null}
        </div>
        {choices.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label={t("scanChoose")}>
            {choices.map((hit) => (
              <li key={hit.variantId}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start py-2 text-left"
                  onClick={() => pickChoice(hit)}
                >
                  <span className="font-medium">{hit.label}</span>
                  {hit.sku ? <span className="text-muted-foreground">{hit.sku}</span> : null}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <Label htmlFor="stocktake-search">{t("searchLabel")}</Label>
          <Input
            id="stocktake-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <Label htmlFor="stocktake-filter">{t("filterLabel")}</Label>
          <NativeSelect
            id="stocktake-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="all">{t("filterAll")}</option>
            <option value="counted">{t("filterCounted")}</option>
            <option value="uncounted">{t("filterUncounted")}</option>
          </NativeSelect>
        </div>
        <p className="pb-3 text-sm text-muted-foreground" aria-live="polite">
          {t("counts", { counted, total: lines.size })}
        </p>
      </div>

      {lines.size === 0 ? (
        <EmptyState icon={ScanBarcode} title={t("noLines")} description={t("noLinesDescription")} />
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {visible.map((line) => {
            const draft = drafts[line.variantId];
            const value = draft ?? toInput(line.countedMilli);
            const status = saves[line.variantId];
            const fractional = isFractionalUnit(line.unit);
            return (
              <li key={line.variantId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-medium">{line.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {line.sku ?? ""}
                    {line.countedMilli === null ? (
                      <span className="ml-2">{t("notCounted")}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {fractional ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t("minusOne", { name: line.label })}
                      disabled={(line.countedMilli ?? 0) <= 0}
                      onClick={() =>
                        void save(
                          line,
                          "set",
                          Math.max(0, (line.countedMilli ?? 0) - MILLI_PER_UNIT),
                        )
                      }
                    >
                      <Minus aria-hidden />
                    </Button>
                  )}
                  <Input
                    ref={(el) => {
                      if (el) rowInputs.current.set(line.variantId, el);
                      else rowInputs.current.delete(line.variantId);
                    }}
                    inputMode={fractional ? "decimal" : "numeric"}
                    autoComplete="off"
                    aria-label={t("qtyLabel", { name: line.label })}
                    aria-invalid={status?.state === "error" ? true : undefined}
                    className="w-24 text-center tabular-nums"
                    value={value}
                    placeholder="—"
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [line.variantId]: e.target.value }))
                    }
                    onBlur={() => commit(line)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit(line);
                        scanRef.current?.focus();
                      }
                    }}
                  />
                  {fractional ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t("plusOne", { name: line.label })}
                      onClick={() => void save(line, "add", MILLI_PER_UNIT)}
                    >
                      <Plus aria-hidden />
                    </Button>
                  )}
                </div>
                <p className="w-24 text-xs text-muted-foreground" role="status" aria-live="polite">
                  {status?.state === "saving" ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                      {t("saving")}
                    </span>
                  ) : status?.state === "saved" ? (
                    <span className="inline-flex items-center gap-1">
                      <Check className="size-3" aria-hidden />
                      {t("saved")}
                    </span>
                  ) : status?.state === "error" ? (
                    <span className="text-destructive">{status.error ?? t("saveFailed")}</span>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
