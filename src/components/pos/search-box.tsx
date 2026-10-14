"use client";

import { Camera, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { parseQty } from "@/domain/qty";
import { searchCatalogAction } from "@/server/actions/register";
import { useFormat } from "./use-format";

/** "3*4901234567890" -> 3 pieces of that code (quantity prefix typed or scanned). */
export function parseQuantityPrefix(raw: string): { qtyMilli: number; code: string } | null {
  const match = /^(\d+(?:[.,]\d{1,3})?)\s*[*xх×]\s*(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const qty = parseQty(match[1]!, "KG"); // any positive milli value; the cart validates per unit
  return qty === null ? null : { qtyMilli: qty, code: match[2]!.trim() };
}

const CODE_LIKE = /^[A-Za-z0-9._-]{3,}$/;

/**
 * Search-as-you-type box. Typing a code and pressing Enter (what a USB scanner
 * does inside the focused box) resolves the exact barcode/SKU/PLU first and
 * adds the line; otherwise Enter picks the highlighted result.
 */
export function SearchBox({
  inputRef,
  disabled,
  onPick,
  onCode,
  onCamera,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  onPick: (entry: CatalogEntry, qtyMilli?: number) => void;
  /** Resolve an exact code; true when it matched a product. */
  onCode: (code: string, qtyMilli?: number) => Promise<boolean>;
  onCamera: () => void;
}) {
  const t = useTranslations("pos.search");
  const format = useFormat();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogEntry[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const ticket = useRef(0);

  useEffect(() => {
    const value = query.trim();
    if (!value) return;
    const mine = ++ticket.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const result = await searchCatalogAction({ query: value });
        if (mine !== ticket.current) return;
        setResults(result.ok ? result.data : []);
        setActive(0);
        setOpen(true);
      } catch {
        if (mine === ticket.current) setResults([]);
      } finally {
        if (mine === ticket.current) setBusy(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const clear = () => {
    ticket.current++;
    setQuery("");
    setResults([]);
    setOpen(false);
    setBusy(false);
  };

  const pick = (entry: CatalogEntry, qtyMilli?: number) => {
    onPick(entry, qtyMilli);
    clear();
    inputRef.current?.focus();
  };

  const submit = async () => {
    const raw = query.trim();
    if (!raw) return;
    const prefixed = parseQuantityPrefix(raw);
    const value = prefixed?.code ?? raw;
    const qtyMilli = prefixed?.qtyMilli;
    const local = results.find(
      (r) => r.barcode === value || r.sku?.toLowerCase() === value.toLowerCase(),
    );
    if (local) return pick(local, qtyMilli);
    if (CODE_LIKE.test(value)) {
      setBusy(true);
      const matched = await onCode(value, qtyMilli).finally(() => setBusy(false));
      if (matched) {
        clear();
        inputRef.current?.focus();
        return;
      }
    }
    const chosen = open ? results[active] : undefined;
    if (chosen) return pick(chosen, qtyMilli);
    setNotFound(true);
  };

  return (
    <div className="relative flex w-full min-w-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          role="combobox"
          aria-label={t("label")}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          aria-keyshortcuts="/"
          autoComplete="off"
          autoFocus
          disabled={disabled}
          className="h-12 pl-10 text-base"
          placeholder={t("placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setNotFound(false);
            if (!event.target.value.trim()) clear();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Escape") {
              if (query) {
                event.stopPropagation();
                clear();
              }
            } else if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {busy ? (
          <Loader2
            aria-hidden
            className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        ) : null}
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={t("results")}
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(24rem,60dvh)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            {results.length === 0 ? (
              <li className="px-3 py-3 text-sm text-muted-foreground">{t("noResults")}</li>
            ) : (
              results.map((entry, index) => (
                <li
                  key={entry.variantId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={
                    "flex min-h-12 cursor-pointer items-center justify-between gap-3 px-3 py-2 " +
                    (index === active ? "bg-accent" : "")
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(entry)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{entry.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[entry.sku, entry.barcode].filter(Boolean).join(" · ")}
                      {entry.onHandMilli !== null
                        ? ` · ${t("onHand", { qty: format.qty(entry.onHandMilli, entry.unit) })}`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {format.money(entry.price)}
                  </span>
                </li>
              ))
            )}
          </ul>
        ) : null}
        <p role="status" className="sr-only">
          {notFound ? t("notFound") : open ? t("resultCount", { count: results.length }) : ""}
        </p>
      </div>
      {notFound ? (
        <span className="hidden text-sm text-destructive sm:inline" aria-hidden>
          {t("notFound")}
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-12 shrink-0"
        aria-label={t("camera")}
        aria-keyshortcuts="F7"
        onClick={onCamera}
      >
        <Camera aria-hidden />
      </Button>
    </div>
  );
}
