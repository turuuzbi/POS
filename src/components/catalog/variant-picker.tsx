"use client";

import { Loader2, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { formatQty } from "@/domain/qty";
import { cn } from "@/lib/utils";
import { findVariants } from "@/server/actions/catalog-search";

export type PickedVariant = Extract<
  Awaited<ReturnType<typeof findVariants>>,
  { ok: true }
>["data"][number];

/**
 * Search-as-you-type product picker (combobox). Works with a USB barcode
 * scanner: a scan is typed + Enter, and an exact code match is picked
 * immediately.
 */
export function VariantPicker({
  onPick,
  locationId,
  stockOnly,
  autoFocus,
  label,
}: {
  onPick: (variant: PickedVariant) => void;
  locationId?: string | null;
  stockOnly?: boolean;
  autoFocus?: boolean;
  /** Accessible label; defaults to "Find a product". */
  label?: string;
}) {
  const t = useTranslations("picker");
  const locale = useLocale();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedVariant[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);
  const pendingEnter = useRef(false);

  const pick = (variant: PickedVariant) => {
    onPick(variant);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  const run = (value: string) => {
    const ticket = ++latest.current;
    startTransition(async () => {
      const result = await findVariants({ query: value, locationId, stockOnly });
      if (ticket !== latest.current) return; // a newer search superseded this one
      const hits = result.ok ? result.data : [];
      setResults(hits);
      setActive(0);
      setOpen(true);
      if (pendingEnter.current) {
        pendingEnter.current = false;
        const exact = hits.filter((hit) => hit.exact);
        if (exact.length === 1) pick(exact[0]!);
      }
    });
  };

  useEffect(() => {
    const value = query.trim();
    if (!value) return;
    const timer = setTimeout(() => run(value), 180);
    return () => clearTimeout(timer);
    // run only closes over props that restart the search anyway
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, locationId, stockOnly]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      latest.current++; // drop any search still in flight
      setResults([]);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        role="combobox"
        aria-label={label ?? t("search")}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        className="pl-9"
        placeholder={t("searchPlaceholder")}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Escape") {
            setOpen(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && results[active] && !pending) {
              pick(results[active]);
            } else if (query.trim()) {
              // A scanner types faster than the debounce: search now, pick an exact hit.
              pendingEnter.current = true;
              run(query.trim());
            }
          }
        }}
      />
      {pending ? (
        <Loader2
          aria-label={t("searching")}
          className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      ) : null}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t("noResults")}</li>
          ) : (
            results.map((hit, index) => (
              <li
                key={hit.variantId}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={cn(
                  "flex min-h-11 cursor-pointer flex-col justify-center rounded-sm px-3 py-1.5",
                  index === active && "bg-accent text-accent-foreground",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(hit)}
              >
                <span className="text-sm font-medium">{hit.label}</span>
                <span className="text-xs text-muted-foreground">
                  {[
                    hit.sku,
                    hit.barcode,
                    hit.onHandMilli !== null
                      ? t("onHand", { qty: formatQty(hit.onHandMilli, hit.unit, { locale }) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
