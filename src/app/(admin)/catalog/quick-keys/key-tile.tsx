import { TILE_COLORS, isTileColor } from "@/components/catalog/tile-colors";
import { tileTextClass } from "@/domain/quick-keys";
import { cn } from "@/lib/utils";

/** One register tile, exactly as the cashier sees it (not interactive). */
export function KeyTile({
  name,
  color,
  priceLabel,
  dimmed,
}: {
  name: string;
  color: string | null;
  priceLabel: string | null;
  dimmed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-20 flex-col justify-between gap-1 rounded-lg border p-2 text-left",
        isTileColor(color) ? TILE_COLORS[color] : "bg-muted",
        tileTextClass(color),
        dimmed && "opacity-60",
      )}
    >
      <span className="line-clamp-2 text-sm leading-tight font-semibold break-words">{name}</span>
      {priceLabel ? <span className="text-xs font-medium tabular-nums">{priceLabel}</span> : null}
    </div>
  );
}
