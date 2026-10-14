"use client";

import { Camera, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { parseQuantityPrefix } from "@/lib/pos/quantity-prefix";
import { createSerialQueue } from "@/lib/pos/serial-queue";
import { searchCatalogAction } from "@/server/actions/register";
import { useFormat } from "./use-format";

const CODE_LIKE = /^[A-Za-z0-9._-]{3,}$/;

/** What was on screen when Enter was pressed. */
interface Submission {
  raw: string;
  results: CatalogEntry[];
  active: number;
  open: boolean;
}

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
  /** Add the entry; false when the cart refused it (the text then stays for correction). */
  onPick: (entry: CatalogEntry, qtyMilli?: number) => boolean;
  /** Resolve an exact code; true when it matched a product. `quiet`: no "not found" toast. */
  onCode: (code: string, qtyMilli?: number, options?: { quiet?: boolean }) => Promise<boolean>;
  onCamera: () => void;
}) {
  const t = useTranslations("pos.search");
  const format = useFormat();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogEntry[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [lookups, setLookups] = useState(0);
  const [notFound, setNotFound] = useState(false);
  const ticket = useRef(0);
  const queryRef = useRef("");
  const queue = useRef(createSerialQueue());

  useEffect(() => {
    const value = query.trim();
    if (!value) return;
    const mine = ++ticket.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const result = await searchCatalogAction({ query: value });
        if (mine !== ticket.current) return;
        setResults(result.ok ? result.data : []);
        setActive(0);
        setOpen(true);
      } catch {
        if (mine === ticket.current) setResults([]);
      } finally {
        if (mine === ticket.current) setSearching(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  /** The text as typed right now (state lags a render behind a fast scanner). */
  const setText = (value: string) => {
    queryRef.current = value;
    setQuery(value);
  };

  const clear = () => {
    ticket.current++;
    setText("");
    setResults([]);
    setOpen(false);
    setSearching(false);
  };

  const pick = (entry: CatalogEntry, qtyMilli?: number) => {
    if (!onPick(entry, qtyMilli)) return;
    clear();
    inputRef.current?.focus();
  };

  /** Resolve one submitted text; true when it was handled, false to give it back for correction. */
  const resolve = async ({ raw, results, active, open }: Submission): Promise<boolean> => {
    const prefixed = parseQuantityPrefix(raw);
    const exact = (code: string) =>
      results.find((r) => r.barcode === code || r.sku?.toLowerCase() === code.toLowerCase());
    const take = (entry: CatalogEntry, qtyMilli?: number) => onPick(entry, qtyMilli);
    if (prefixed) {
      // The whole text may itself be a code or SKU ("2x4-BOARD"): that beats a quantity prefix.
      const whole = exact(raw);
      if (whole) return take(whole);
      if (CODE_LIKE.test(raw) && (await onCode(raw, undefined, { quiet: true }))) return true;
    }
    const value = prefixed?.code ?? raw;
    const qtyMilli = prefixed?.qtyMilli;
    const local = exact(value);
    if (local) return take(local, qtyMilli);
    if (CODE_LIKE.test(value) && (await onCode(value, qtyMilli))) return true;
    const chosen = open ? results[active] : undefined;
    if (chosen) return take(chosen, qtyMilli);
    setNotFound(true);
    return false;
  };

  /**
   * Take the typed text out of the box at once and look it up in order behind
   * any lookup still running. A scanner may type the next code while the
   * previous one is in flight: that code must neither be glued to the old text
   * nor wiped when the old lookup returns. A text that could not be handled is
   * put back for correction, unless something new has been typed meanwhile.
   */
  const submit = () => {
    const raw = queryRef.current.trim();
    if (!raw) return;
    const submission: Submission = { raw, results, active, open };
    clear();
    inputRef.current?.focus();
    setLookups((n) => n + 1);
    const giveBack = () => {
      if (queryRef.current === "") setText(raw);
    };
    queue.current
      .run(() => resolve(submission))
      .then((handled) => {
        if (!handled) giveBack();
      })
      .catch(giveBack)
      .finally(() => setLookups((n) => n - 1));
  };

  const busy = searching || lookups > 0;

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
            queryRef.current = event.target.value;
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
              submit();
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
