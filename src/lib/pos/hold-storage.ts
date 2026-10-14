/**
 * Browser storage for the register: the cart being rung up (so a reload loses
 * nothing) and parked ("held") carts. Everything is scoped per register +
 * cashier, validated on read (storage can hold anything) and every access is
 * wrapped so private windows / blocked storage degrade to "nothing saved".
 *
 * A held cart keeps its sale UUID: the id is minted when the cart opens and
 * only a COMPLETED sale retires it.
 */
import { z } from "zod";
import type { Cart, CartLine } from "@/domain/cart";
import type { DiscountRequest } from "@/domain/discounts";
import { catalogEntryJsonSchema, entryToJson, type CatalogEntry } from "./catalog-entry";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MAX_HELD_CARTS = 20;
const VERSION = "v1";

export function storageScope(registerId: string | null, userId: string): string {
  return `${registerId ?? "none"}:${userId}`;
}
export const draftKey = (scope: string) => `pos:draft:${VERSION}:${scope}`;
export const heldKey = (scope: string) => `pos:held:${VERSION}:${scope}`;

// --- Cart <-> JSON ---------------------------------------------------------------

const money = z.string().regex(/^\d{1,15}$/);

const discountJson = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("PERCENT"),
    percentBps: z.number().int().min(1).max(10_000),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal("FIXED"), amount: money, reason: z.string().optional() }),
]);

const lineJson = z.object({
  lineId: z.string().min(1),
  variantId: z.string().min(1),
  qtyMilli: z.number().int().positive(),
  unitPrice: money,
  priceOverride: money.optional(),
  discounts: z.array(discountJson),
  note: z.string().optional(),
  voided: z.boolean().optional(),
  scaleBarcode: z.string().optional(),
  labelTotal: money.optional(),
});

export const cartJsonSchema = z.object({
  lines: z.array(lineJson),
  discounts: z.array(discountJson),
});
export type CartJson = z.input<typeof cartJsonSchema>;

function discountToJson(d: DiscountRequest): z.input<typeof discountJson> {
  return d.kind === "PERCENT"
    ? { kind: "PERCENT", percentBps: d.percentBps, ...(d.reason ? { reason: d.reason } : {}) }
    : { kind: "FIXED", amount: d.amount.toString(), ...(d.reason ? { reason: d.reason } : {}) };
}

function discountFromJson(d: z.output<typeof discountJson>): DiscountRequest {
  return d.kind === "PERCENT"
    ? { kind: "PERCENT", percentBps: d.percentBps, ...(d.reason ? { reason: d.reason } : {}) }
    : { kind: "FIXED", amount: BigInt(d.amount), ...(d.reason ? { reason: d.reason } : {}) };
}

export function cartToJson(cart: Cart): CartJson {
  return {
    lines: cart.lines.map((l) => ({
      lineId: l.lineId,
      variantId: l.variantId,
      qtyMilli: l.qtyMilli,
      unitPrice: l.unitPrice.toString(),
      ...(l.priceOverride !== undefined ? { priceOverride: l.priceOverride.toString() } : {}),
      discounts: l.discounts.map(discountToJson),
      ...(l.note ? { note: l.note } : {}),
      ...(l.voided ? { voided: true } : {}),
      ...(l.scaleBarcode ? { scaleBarcode: l.scaleBarcode } : {}),
      ...(l.labelTotal !== undefined ? { labelTotal: l.labelTotal.toString() } : {}),
    })),
    discounts: cart.discounts.map(discountToJson),
  };
}

export function cartFromJson(json: unknown): Cart | null {
  const parsed = cartJsonSchema.safeParse(json);
  if (!parsed.success) return null;
  const lines: CartLine[] = parsed.data.lines.map((l) => ({
    lineId: l.lineId,
    variantId: l.variantId,
    qtyMilli: l.qtyMilli,
    unitPrice: BigInt(l.unitPrice),
    ...(l.priceOverride !== undefined ? { priceOverride: BigInt(l.priceOverride) } : {}),
    discounts: l.discounts.map(discountFromJson),
    ...(l.note ? { note: l.note } : {}),
    ...(l.voided ? { voided: true } : {}),
    ...(l.scaleBarcode ? { scaleBarcode: l.scaleBarcode } : {}),
    ...(l.labelTotal !== undefined ? { labelTotal: BigInt(l.labelTotal) } : {}),
  }));
  return { lines, discounts: parsed.data.discounts.map(discountFromJson) };
}

// --- Records -----------------------------------------------------------------------

const entriesJson = z.array(catalogEntryJsonSchema.extend({ price: money }));

const recordFields = {
  saleId: z.string().min(1),
  createdAt: z.number().int(),
  cart: cartJsonSchema,
  entries: entriesJson,
};

const draftSchema = z.object({
  ...recordFields,
  /** Wire input of a charge whose outcome is unknown; resent verbatim (same saleId). */
  pendingCharge: z.unknown().optional(),
});

const heldSchema = z.object({
  ...recordFields,
  heldAt: z.number().int(),
  label: z.string().max(60).optional(),
});

export interface Draft {
  saleId: string;
  createdAt: number;
  cart: Cart;
  entries: CatalogEntry[];
  pendingCharge?: unknown;
}

export interface HeldCart {
  saleId: string;
  createdAt: number;
  heldAt: number;
  cart: Cart;
  entries: CatalogEntry[];
  label?: string;
}

function entriesFromJson(rows: z.output<typeof entriesJson>): CatalogEntry[] {
  return rows.map((row) => ({ ...row, price: BigInt(row.price) }));
}

function entriesForCart(cart: Cart, entries: Readonly<Record<string, CatalogEntry>>) {
  const ids = new Set(cart.lines.map((l) => l.variantId));
  return [...ids].flatMap((id) => (entries[id] ? [entries[id]] : []));
}

function read(storage: StorageLike | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // quota / blocked storage: the cart simply is not persisted
  }
}

function remove(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // ignore
  }
}

// --- Draft (the cart in progress) --------------------------------------------------

export function saveDraft(storage: StorageLike | null, scope: string, draft: Draft): void {
  write(storage, draftKey(scope), {
    saleId: draft.saleId,
    createdAt: draft.createdAt,
    cart: cartToJson(draft.cart),
    entries: draft.entries.map(entryToJson),
    ...(draft.pendingCharge !== undefined ? { pendingCharge: draft.pendingCharge } : {}),
  });
}

export function loadDraft(storage: StorageLike | null, scope: string): Draft | null {
  const parsed = draftSchema.safeParse(read(storage, draftKey(scope)));
  if (!parsed.success) return null;
  const cart = cartFromJson(parsed.data.cart);
  if (!cart) return null;
  return {
    saleId: parsed.data.saleId,
    createdAt: parsed.data.createdAt,
    cart,
    entries: entriesFromJson(parsed.data.entries),
    ...(parsed.data.pendingCharge !== undefined
      ? { pendingCharge: parsed.data.pendingCharge }
      : {}),
  };
}

export function clearDraft(storage: StorageLike | null, scope: string): void {
  remove(storage, draftKey(scope));
}

// --- Held carts ----------------------------------------------------------------------

export function loadHeld(storage: StorageLike | null, scope: string): HeldCart[] {
  const raw = read(storage, heldKey(scope));
  if (!Array.isArray(raw)) return [];
  const out: HeldCart[] = [];
  for (const item of raw) {
    const parsed = heldSchema.safeParse(item);
    if (!parsed.success) continue;
    const cart = cartFromJson(parsed.data.cart);
    if (!cart) continue;
    out.push({
      saleId: parsed.data.saleId,
      createdAt: parsed.data.createdAt,
      heldAt: parsed.data.heldAt,
      cart,
      entries: entriesFromJson(parsed.data.entries),
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
    });
  }
  return out.sort((a, b) => a.heldAt - b.heldAt);
}

function saveHeld(storage: StorageLike | null, scope: string, held: readonly HeldCart[]): void {
  write(
    storage,
    heldKey(scope),
    held.map((h) => ({
      saleId: h.saleId,
      createdAt: h.createdAt,
      heldAt: h.heldAt,
      cart: cartToJson(h.cart),
      entries: h.entries.map(entryToJson),
      ...(h.label ? { label: h.label } : {}),
    })),
  );
}

export type HoldResult = { ok: true; held: HeldCart[] } | { ok: false; reason: "FULL" | "EMPTY" };

/** Park a cart. Parking the same sale again replaces its earlier copy. */
export function holdCart(
  storage: StorageLike | null,
  scope: string,
  cart: {
    saleId: string;
    createdAt: number;
    cart: Cart;
    entries: Readonly<Record<string, CatalogEntry>>;
    label?: string;
  },
  now: number,
): HoldResult {
  if (cart.cart.lines.every((l) => l.voided)) return { ok: false, reason: "EMPTY" };
  const others = loadHeld(storage, scope).filter((h) => h.saleId !== cart.saleId);
  if (others.length >= MAX_HELD_CARTS) return { ok: false, reason: "FULL" };
  const entries = entriesForCart(cart.cart, cart.entries);
  const held = [
    ...others,
    {
      saleId: cart.saleId,
      createdAt: cart.createdAt,
      heldAt: now,
      cart: cart.cart,
      entries,
      ...(cart.label ? { label: cart.label } : {}),
    },
  ];
  saveHeld(storage, scope, held);
  return { ok: true, held };
}

/** Remove a held cart (resumed or discarded); returns what remains. */
export function releaseHeld(storage: StorageLike | null, scope: string, saleId: string) {
  const held = loadHeld(storage, scope).filter((h) => h.saleId !== saleId);
  saveHeld(storage, scope, held);
  return held;
}
