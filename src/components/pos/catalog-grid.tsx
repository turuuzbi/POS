"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { TILE_COLORS, isTileColor } from "@/components/catalog/tile-colors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { cn } from "@/lib/utils";
import { browseCatalogAction } from "@/server/actions/register";
import type { QuickKeyTile, RegisterCategory } from "@/server/queries/register";
import { useFormat } from "./use-format";

const FAVOURITES = "__fav";
const ALL = "__all";

interface TileView {
  id: string;
  name: string;
  color: string | null;
  price: bigint | null;
  /** Entries this tile adds (several = variant chooser). */
  entries: CatalogEntry[];
}

function colorBar(color: string | null | undefined) {
  return isTileColor(color) ? TILE_COLORS[color] : "bg-muted-foreground/40";
}

function Tile({ tile, onPress }: { tile: TileView; onPress: () => void }) {
  const format = useFormat();
  const t = useTranslations("pos.grid");
  return (
    <button
      type="button"
      onClick={onPress}
      className="group relative flex min-h-24 flex-col justify-between overflow-hidden rounded-lg border bg-card p-3 pt-4 text-left text-card-foreground shadow-xs transition-[box-shadow,transform] outline-none hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring active:scale-[0.98]"
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1.5", colorBar(tile.color))} />
      <span className="line-clamp-2 text-sm leading-snug font-medium break-words">{tile.name}</span>
      <span className="mt-2 text-sm font-semibold tabular-nums">
        {tile.entries.length > 1
          ? t("variants", { count: tile.entries.length })
          : tile.price !== null
            ? format.money(tile.price)
            : ""}
      </span>
    </button>
  );
}

/**
 * Quick-key grid with category tabs. Quick keys come from the QuickKey table;
 * when a location has none, the grid falls back to browsing the catalog by
 * category ("all products" first).
 */
export function CatalogGrid({
  quickKeys,
  categories,
  entries,
  onPick,
  onChoose,
}: {
  quickKeys: readonly QuickKeyTile[];
  categories: readonly RegisterCategory[];
  entries: Readonly<Record<string, CatalogEntry>>;
  onPick: (entry: CatalogEntry) => void;
  onChoose: (entries: CatalogEntry[], title: string) => void;
}) {
  const t = useTranslations("pos.grid");
  const quickMode = quickKeys.length > 0;

  const tabs = useMemo(() => {
    if (quickMode) {
      const used = new Set(quickKeys.map((k) => k.categoryId));
      const list: { id: string; name: string; color: string | null }[] = [];
      if (used.has(null)) list.push({ id: FAVOURITES, name: t("favourites"), color: null });
      for (const category of categories) {
        if (used.has(category.id)) list.push(category);
      }
      return list;
    }
    return [
      { id: ALL, name: t("all"), color: null },
      ...categories.filter((c) => c.parentId === null),
    ];
  }, [quickMode, quickKeys, categories, t]);

  const [tab, setTab] = useState(tabs[0]?.id ?? ALL);
  const activeTab = tabs.some((x) => x.id === tab) ? tab : (tabs[0]?.id ?? ALL);

  return (
    <Tabs value={activeTab} onValueChange={setTab} className="min-h-0 flex-1 gap-2">
      <TabsList
        aria-label={t("tabs")}
        className="h-auto w-full shrink-0 justify-start gap-1 overflow-x-auto"
      >
        {tabs.map((item) => (
          <TabsTrigger key={item.id} value={item.id} className="min-h-11 shrink-0 px-4">
            {item.color ? (
              <span aria-hidden className={cn("size-2.5 rounded-full", colorBar(item.color))} />
            ) : null}
            {item.name}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={activeTab} className="min-h-0 flex-1 overflow-y-auto pb-2">
        {quickMode ? (
          <QuickKeyTiles
            tiles={quickKeys.filter((k) =>
              activeTab === FAVOURITES ? k.categoryId === null : k.categoryId === activeTab,
            )}
            entries={entries}
            onPick={onPick}
            onChoose={onChoose}
          />
        ) : (
          <BrowseTiles
            categoryId={activeTab === ALL ? null : activeTab}
            categories={categories}
            onPick={onPick}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))] gap-2";

function QuickKeyTiles({
  tiles,
  entries,
  onPick,
  onChoose,
}: {
  tiles: readonly QuickKeyTile[];
  entries: Readonly<Record<string, CatalogEntry>>;
  onPick: (entry: CatalogEntry) => void;
  onChoose: (entries: CatalogEntry[], title: string) => void;
}) {
  const views: TileView[] = tiles.flatMap((tile) => {
    const list = tile.variantIds.flatMap((id) => (entries[id] ? [entries[id]] : []));
    const first = list[0];
    return first
      ? [{ id: tile.id, name: tile.name, color: tile.color, price: first.price, entries: list }]
      : [];
  });
  return (
    <div className={GRID}>
      {views.map((view) => (
        <Tile
          key={view.id}
          tile={view}
          onPress={() => {
            const only = view.entries[0];
            if (view.entries.length === 1 && only) onPick(only);
            else onChoose(view.entries, view.name);
          }}
        />
      ))}
    </div>
  );
}

function BrowseTiles({
  categoryId,
  categories,
  onPick,
}: {
  categoryId: string | null;
  categories: readonly RegisterCategory[];
  onPick: (entry: CatalogEntry) => void;
}) {
  const t = useTranslations("pos.grid");
  const [loaded, setLoaded] = useState<Record<string, CatalogEntry[] | "error">>({});
  const [nonce, setNonce] = useState(0);
  const key = categoryId ?? ALL;
  const data = loaded[key];
  const fetched = useRef(new Set<string>());

  useEffect(() => {
    const token = `${key}:${nonce}`;
    if (fetched.current.has(token)) return;
    fetched.current.add(token);
    void (async () => {
      let next: CatalogEntry[] | "error" = "error";
      try {
        const result = await browseCatalogAction({ categoryId });
        if (result.ok) next = result.data;
      } catch {
        next = "error";
      }
      setLoaded((prev) => ({ ...prev, [key]: next }));
    })();
  }, [key, nonce, categoryId]);

  const retry = () => {
    setLoaded((prev) => {
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setNonce((n) => n + 1);
  };

  if (data === undefined) {
    return (
      <div className={GRID} aria-busy="true" aria-label={t("loading")}>
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  if (data === "error") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
        <p>{t("loadFailed")}</p>
        <Button variant="outline" onClick={retry}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (data.length === 0) {
    return <p className="py-10 text-center text-muted-foreground">{t("empty")}</p>;
  }
  return (
    <div className={GRID}>
      {data.map((entry) => (
        <Tile
          key={entry.variantId}
          tile={{
            id: entry.variantId,
            name: entry.label,
            color: categories.find((c) => c.id === entry.categoryId)?.color ?? null,
            price: entry.price,
            entries: [entry],
          }}
          onPress={() => onPick(entry)}
        />
      ))}
    </div>
  );
}
