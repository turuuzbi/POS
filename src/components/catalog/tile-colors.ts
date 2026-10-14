/** Quick-key / category tile colours (token → literal Tailwind classes). */
export const TILE_COLORS = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-600",
  teal: "bg-teal-600",
  blue: "bg-blue-600",
  violet: "bg-violet-600",
  pink: "bg-pink-500",
} as const;

export type TileColor = keyof typeof TILE_COLORS;
export const TILE_COLOR_KEYS = Object.keys(TILE_COLORS) as TileColor[];

export function isTileColor(value: string | null | undefined): value is TileColor {
  return value != null && value in TILE_COLORS;
}
