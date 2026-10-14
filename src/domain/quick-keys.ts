/**
 * Quick-key grid rules (pure; shared by the admin editor, server actions and
 * the register). A grid is one tab of one location: tabs are categories, or
 * the "favourites" tab when `categoryId` is null.
 */
import { z } from "zod";
import { TILE_COLOR_KEYS } from "@/components/catalog/tile-colors";

/** Most keys on one tab (a 6x8 grid already scrolls on a phone). */
export const MAX_QUICK_KEYS_PER_TAB = 48;

const tileColor = z
  .string()
  .nullable()
  .refine((value) => value === null || (TILE_COLOR_KEYS as string[]).includes(value), "invalid");

/** Where a key lives: a location and a tab (null = favourites). */
export const quickKeyTabSchema = z.object({
  locationId: z.uuid(),
  categoryId: z.uuid().nullable(),
});
export type QuickKeyTab = z.infer<typeof quickKeyTabSchema>;

export const addQuickKeyInputSchema = quickKeyTabSchema.extend({
  productId: z.uuid(),
  color: tileColor.default(null),
});
export type AddQuickKeyInput = z.infer<typeof addQuickKeyInputSchema>;

export const setQuickKeyColorInputSchema = z.object({ id: z.uuid(), color: tileColor });
export type SetQuickKeyColorInput = z.infer<typeof setQuickKeyColorInputSchema>;

export const removeQuickKeyInputSchema = z.object({ id: z.uuid() });

/** The complete new order of a tab's keys (every id, exactly once). */
export const reorderQuickKeysInputSchema = quickKeyTabSchema.extend({
  orderedIds: z.array(z.uuid()).max(MAX_QUICK_KEYS_PER_TAB),
});
export type ReorderQuickKeysInput = z.infer<typeof reorderQuickKeysInputSchema>;

/** Move `id` one step earlier/later; unchanged when it can't move or isn't there. */
export function moveId(ids: readonly string[], id: string, direction: "earlier" | "later") {
  const from = ids.indexOf(id);
  const to = direction === "earlier" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** Same members, no repeats: the check that a reorder is a permutation. */
export function isPermutation(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(b).size === b.length && a.every((id) => b.includes(id));
}

/** Text colour for a tile of this colour (white only where it keeps AA contrast). */
export function tileTextClass(color: string | null): string {
  return color === "slate" || color === "blue" || color === "violet"
    ? "text-white"
    : color
      ? "text-black"
      : "text-foreground";
}

/** Seed/category colours outside the tile palette map to the nearest tile. */
export function toTileColor(color: string | null | undefined): string | null {
  if (!color) return null;
  if ((TILE_COLOR_KEYS as string[]).includes(color)) return color;
  return color === "sky" || color === "cyan" ? "blue" : null;
}
