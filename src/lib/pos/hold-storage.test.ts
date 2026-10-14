import { describe, expect, it } from "vitest";
import type { Cart } from "@/domain/cart";
import type { CatalogEntry } from "./catalog-entry";
import {
  MAX_HELD_CARTS,
  cartFromJson,
  cartToJson,
  clearDraft,
  draftKey,
  holdCart,
  loadDraft,
  loadHeld,
  releaseHeld,
  saveDraft,
  storageScope,
  type StorageLike,
} from "./hold-storage";

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const entry = (id: string, price = 250_000n): CatalogEntry => ({
  variantId: id,
  productId: `p-${id}`,
  label: `Item ${id}`,
  sku: `SKU-${id}`,
  barcode: null,
  unit: "PIECE",
  price,
  pricesIncludeTax: true,
  taxTreatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
  pluCode: null,
  categoryId: null,
  productType: "STANDARD",
  onHandMilli: null,
});

const cart: Cart = {
  lines: [
    {
      lineId: "l1",
      variantId: "v1",
      qtyMilli: 2000,
      unitPrice: 250_000n,
      priceOverride: 200_000n,
      discounts: [
        { kind: "PERCENT", percentBps: 500, reason: "loyal" },
        { kind: "FIXED", amount: 10_000n },
      ],
      note: "gift wrap",
    },
    {
      lineId: "l2",
      variantId: "v2",
      qtyMilli: 1250,
      unitPrice: 1_800_000n,
      discounts: [],
      scaleBarcode: "2000123012507",
      labelTotal: 2_250_000n,
      voided: true,
    },
  ],
  discounts: [{ kind: "PERCENT", percentBps: 1000 }],
};

const scope = storageScope("reg-1", "user-1");
const draft = (saleId: string) => ({
  saleId,
  createdAt: 111,
  cart,
  entries: [entry("v1"), entry("v2")],
});

describe("cart serialisation", () => {
  it("round-trips every field including bigint money", () => {
    const json = JSON.parse(JSON.stringify(cartToJson(cart)));
    expect(cartFromJson(json)).toEqual(cart);
  });

  it("rejects corrupt data instead of throwing", () => {
    expect(cartFromJson({ lines: [{ lineId: 1 }], discounts: [] })).toBeNull();
    expect(cartFromJson("nope")).toBeNull();
    expect(cartFromJson(null)).toBeNull();
  });
});

describe("draft (the cart in progress)", () => {
  it("survives a reload: saved and loaded back, sale id included", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { ...draft("sale-A"), pendingCharge: { saleId: "sale-A" } });
    const loaded = loadDraft(storage, scope);
    expect(loaded?.saleId).toBe("sale-A");
    expect(loaded?.cart).toEqual(cart);
    expect(loaded?.entries.map((e) => e.variantId)).toEqual(["v1", "v2"]);
    expect(loaded?.entries[0]?.price).toBe(250_000n);
    expect(loaded?.pendingCharge).toEqual({ saleId: "sale-A" });
  });

  it("is scoped per register and cashier", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, draft("sale-A"));
    expect(loadDraft(storage, storageScope("reg-2", "user-1"))).toBeNull();
    expect(loadDraft(storage, storageScope("reg-1", "user-2"))).toBeNull();
  });

  it("can be cleared and ignores garbage", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, draft("sale-A"));
    clearDraft(storage, scope);
    expect(loadDraft(storage, scope)).toBeNull();
    storage.setItem(draftKey(scope), "{not json");
    expect(loadDraft(storage, scope)).toBeNull();
  });

  it("degrades to nothing when storage is unavailable or throws", () => {
    expect(loadDraft(null, scope)).toBeNull();
    const broken: StorageLike = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(() => saveDraft(broken, scope, draft("x"))).not.toThrow();
    expect(loadDraft(broken, scope)).toBeNull();
    expect(() => clearDraft(broken, scope)).not.toThrow();
  });
});

describe("held carts", () => {
  const park = (storage: StorageLike, saleId: string, now: number, c: Cart = cart) =>
    holdCart(
      storage,
      scope,
      {
        saleId,
        createdAt: 1,
        cart: c,
        entries: { v1: entry("v1"), v2: entry("v2"), unrelated: entry("zzz") },
      },
      now,
    );

  it("parks a cart with its own sale id and only the entries it uses", () => {
    const storage = new MemoryStorage();
    expect(park(storage, "sale-A", 1000).ok).toBe(true);
    const [held] = loadHeld(storage, scope);
    expect(held?.saleId).toBe("sale-A");
    expect(held?.heldAt).toBe(1000);
    expect(held?.cart).toEqual(cart);
    expect(held?.entries.map((e) => e.variantId).sort()).toEqual(["v1", "v2"]);
  });

  it("lists oldest first and survives a reload (fresh read of storage)", () => {
    const storage = new MemoryStorage();
    park(storage, "sale-B", 2000);
    park(storage, "sale-A", 1000);
    expect(loadHeld(storage, scope).map((h) => h.saleId)).toEqual(["sale-A", "sale-B"]);
  });

  it("parking the same sale again replaces its earlier copy", () => {
    const storage = new MemoryStorage();
    park(storage, "sale-A", 1000);
    park(storage, "sale-A", 2000);
    const held = loadHeld(storage, scope);
    expect(held).toHaveLength(1);
    expect(held[0]?.heldAt).toBe(2000);
  });

  it("refuses an empty cart and a full list", () => {
    const storage = new MemoryStorage();
    expect(park(storage, "e", 1, { lines: [], discounts: [] })).toEqual({
      ok: false,
      reason: "EMPTY",
    });
    for (let i = 0; i < MAX_HELD_CARTS; i++) park(storage, `sale-${i}`, i);
    expect(park(storage, "one-too-many", 99)).toEqual({ ok: false, reason: "FULL" });
  });

  it("release removes just that cart", () => {
    const storage = new MemoryStorage();
    park(storage, "sale-A", 1);
    park(storage, "sale-B", 2);
    const rest = releaseHeld(storage, scope, "sale-A");
    expect(rest.map((h) => h.saleId)).toEqual(["sale-B"]);
    expect(loadHeld(storage, scope).map((h) => h.saleId)).toEqual(["sale-B"]);
  });

  it("skips corrupt entries but keeps the good ones", () => {
    const storage = new MemoryStorage();
    park(storage, "sale-A", 1);
    const key = [...storage.data.keys()].find((k) => k.includes("held"))!;
    const list = JSON.parse(storage.data.get(key)!);
    storage.setItem(key, JSON.stringify([{ saleId: 5 }, ...list]));
    expect(loadHeld(storage, scope).map((h) => h.saleId)).toEqual(["sale-A"]);
  });
});
