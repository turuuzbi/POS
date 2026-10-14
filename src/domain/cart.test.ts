import { describe, expect, it } from "vitest";
import {
  EMPTY_CART,
  MAX_CART_LINES,
  CartError,
  cartReducer,
  computeTotals,
  computeTotalsDetailed,
  reduceCart,
  requiredApprovals,
  type Cart,
  type CartAction,
  type CatalogSnapshot,
  type CatalogVariant,
} from "./cart";
import { fromMajor } from "./money";
import { buildScaleBarcode, DEFAULT_SCALE_RULES } from "./scale-barcode";

const T = fromMajor;
const variant = (id: string, over: Partial<CatalogVariant> = {}): CatalogVariant => ({
  variantId: id,
  unit: "PIECE",
  price: T(1000),
  pricesIncludeTax: true,
  taxTreatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
  ...over,
});
const catalog: CatalogSnapshot = {
  variants: {
    milk: variant("milk", { price: T(3300) }),
    bread: variant("bread", { price: T(1500), taxTreatment: "EXEMPT" }),
    beer: variant("beer", { price: T(5000), cityTaxRateBps: 200 }),
    tomato: variant("tomato", { unit: "KG", price: T(6000), pluCode: "123" }),
    excl: variant("excl", { price: T(1000), pricesIncludeTax: false }),
  },
};

function run(actions: CartAction[], start: Cart = EMPTY_CART): Cart {
  return actions.reduce((cart, a) => {
    const r = reduceCart(cart, a, catalog);
    if (!r.ok) throw r.error;
    return r.cart;
  }, start);
}
const add = (lineId: string, variantId: string, qty = 1): CartAction => ({
  type: "ADD_ITEM",
  lineId,
  variantId,
  qtyMilli: qty * 1000,
});

describe("reducer", () => {
  it("merges piece items, keeps weighed items separate", () => {
    const cart = run([
      add("a", "milk"),
      add("b", "milk", 2),
      { type: "ADD_ITEM", lineId: "c", variantId: "tomato", qtyMilli: 500 },
      { type: "ADD_ITEM", lineId: "d", variantId: "tomato", qtyMilli: 500 },
    ]);
    expect(cart.lines.map((l) => [l.lineId, l.qtyMilli])).toEqual([
      ["a", 3000],
      ["c", 500],
      ["d", 500],
    ]);
  });

  it("does not merge into a voided line or an overridden-price listing", () => {
    const cart = run([add("a", "milk"), { type: "VOID_LINE", lineId: "a" }, add("b", "milk")]);
    expect(cart.lines).toHaveLength(2);
    expect(cart.lines[0]?.voided).toBe(true);
  });

  it("merge:false keeps lines 1:1", () => {
    const cart = run([add("a", "milk"), { ...add("b", "milk"), merge: false } as CartAction]);
    expect(cart.lines).toHaveLength(2);
  });

  it("setQty validates the unit and drops a label total", () => {
    const cart = run([add("a", "milk")]);
    expect(reduceCart(cart, { type: "SET_QTY", lineId: "a", qtyMilli: 1500 }, catalog).ok).toBe(
      false,
    );
    expect(reduceCart(cart, { type: "SET_QTY", lineId: "a", qtyMilli: 0 }, catalog).ok).toBe(false);
    expect(run([{ type: "SET_QTY", lineId: "a", qtyMilli: 4000 }], cart).lines[0]?.qtyMilli).toBe(
      4000,
    );
  });

  it("remove, void, unknown line, unknown variant, duplicate id", () => {
    const cart = run([add("a", "milk"), add("b", "beer")]);
    expect(run([{ type: "REMOVE_LINE", lineId: "a" }], cart).lines.map((l) => l.lineId)).toEqual([
      "b",
    ]);
    const err = (a: CartAction) => {
      const r = reduceCart(cart, a, catalog);
      return r.ok ? null : r.error.code;
    };
    expect(err({ type: "REMOVE_LINE", lineId: "zz" })).toBe("LINE_NOT_FOUND");
    expect(err(add("c", "nope"))).toBe("UNKNOWN_VARIANT");
    expect(err(add("b", "bread"))).toBe("DUPLICATE_LINE_ID");
  });

  it("does not mutate previous state; invalid actions are ignored by cartReducer", () => {
    const cart = run([add("a", "milk")]);
    const snapshot = JSON.stringify(cart, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    run([add("b", "beer"), { type: "SET_QTY", lineId: "a", qtyMilli: 2000 }], cart);
    expect(JSON.stringify(cart, (_, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe(snapshot);
    expect(cartReducer(cart, add("x", "nope"), catalog)).toBe(cart);
  });

  it("caps the number of lines", () => {
    let cart = EMPTY_CART;
    for (let i = 0; i < MAX_CART_LINES; i++)
      cart = run([{ ...add(`l${i}`, "milk"), merge: false } as CartAction], cart);
    const r = reduceCart(cart, { ...add("over", "milk"), merge: false } as CartAction, catalog);
    expect(r.ok ? null : r.error).toBeInstanceOf(CartError);
  });

  it("validates discounts, overrides and notes", () => {
    const cart = run([add("a", "milk")]);
    const bad: CartAction[] = [
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "PERCENT", percentBps: 0 } },
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "FIXED", amount: 0n } },
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "PERCENT", percentBps: 10_001 } },
      { type: "SET_PRICE_OVERRIDE", lineId: "a", price: -1n },
      { type: "SET_NOTE", lineId: "a", note: "x".repeat(201) },
    ];
    for (const a of bad) expect(reduceCart(cart, a, catalog).ok).toBe(false);
  });
});

describe("scale barcodes", () => {
  const rule = DEFAULT_SCALE_RULES[0]!;
  it("weight label becomes a weighed line at the catalog price", () => {
    const code = buildScaleBarcode(rule, "123", 1250); // 1.250 kg
    const cart = run([{ type: "ADD_SCALE", lineId: "s", barcode: code }]);
    expect(cart.lines[0]).toMatchObject({
      variantId: "tomato",
      qtyMilli: 1250,
      scaleBarcode: code,
    });
    expect(computeTotals(cart, catalog).total).toBe(T(7500));
  });

  it("two labels of the same item stay separate lines", () => {
    const code = buildScaleBarcode(rule, "123", 500);
    const cart = run([
      { type: "ADD_SCALE", lineId: "s1", barcode: code },
      { type: "ADD_SCALE", lineId: "s2", barcode: code },
    ]);
    expect(cart.lines).toHaveLength(2);
  });

  it("price label keeps the exact label price", () => {
    const priceRule = { ...rule, valueType: "PRICE" as const, valueDecimals: 0, valueLength: 5 };
    const code = buildScaleBarcode(priceRule, "123", 4999);
    const cart = run([{ type: "ADD_SCALE", lineId: "s", barcode: code, rules: [priceRule] }]);
    expect(cart.lines[0]?.labelTotal).toBe(T(4999));
    expect(computeTotals(cart, catalog).total).toBe(T(4999));
    // a requested price override replaces the label price (and would need approval)
    const over = run([{ type: "SET_PRICE_OVERRIDE", lineId: "s", price: T(5000) }], cart);
    expect(computeTotals(over, catalog).lines[0]?.subtotal).not.toBe(T(4999));
  });

  it("rejects bad checksum / unknown PLU", () => {
    const code = buildScaleBarcode(rule, "123", 500);
    const broken = code.slice(0, 12) + String((Number(code[12]) + 1) % 10);
    expect(
      reduceCart(EMPTY_CART, { type: "ADD_SCALE", lineId: "s", barcode: broken }, catalog).ok,
    ).toBe(false);
    const other = buildScaleBarcode(rule, "999", 500);
    const r = reduceCart(EMPTY_CART, { type: "ADD_SCALE", lineId: "s", barcode: other }, catalog);
    expect(r.ok ? null : r.error.code).toBe("UNKNOWN_VARIANT");
  });
});

describe("computeTotals", () => {
  it("empty cart", () => {
    expect(computeTotals(EMPTY_CART, catalog)).toMatchObject({ total: 0n, payable: 0n, lines: [] });
  });

  it("inclusive line, 10% VAT", () => {
    const t = computeTotals(run([add("a", "milk", 2)]), catalog);
    expect(t.lines[0]).toMatchObject({
      subtotal: T(6600),
      gross: T(6600),
      vat: T(600),
      net: T(6000),
      city: 0n,
    });
    expect(t).toMatchObject({
      subtotal: T(6600),
      discountTotal: 0n,
      taxTotal: T(600),
      total: T(6600),
      payable: T(6600),
    });
  });

  it("exempt and city tax lines", () => {
    const t = computeTotals(run([add("a", "bread"), add("b", "beer")]), catalog);
    expect(t.lines[0]).toMatchObject({ vat: 0n, net: T(1500) });
    // 5000 / 1.12 → vat 446.43 → 44643 möngö ; city 89.29 → 8929
    expect(t.lines[1]).toMatchObject({ vat: 44_643n, city: 8929n, gross: T(5000) });
    expect(t.cityTotal).toBe(8929n);
  });

  it("exclusive line adds tax on top", () => {
    const t = computeTotals(run([add("a", "excl")]), catalog);
    expect(t.lines[0]).toMatchObject({ net: T(1000), vat: T(100), gross: T(1100) });
  });

  it("line discount reduces the tax base", () => {
    const cart = run([
      add("a", "milk"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "PERCENT", percentBps: 1000 } },
    ]);
    const l = computeTotals(cart, catalog).lines[0]!;
    expect(l).toMatchObject({
      subtotal: T(3300),
      lineDiscount: T(330),
      gross: T(2970),
      vat: T(270),
      net: T(2700),
    });
  });

  it("cart discount is allocated exactly and applied after line discounts", () => {
    const cart = run([
      add("a", "milk"),
      add("b", "bread"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "FIXED", amount: T(300) } },
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "PERCENT", percentBps: 1000 } },
    ]);
    const t = computeTotals(cart, catalog);
    // after line discount: milk 3000, bread 1500 → pool 4500, 10% = 450
    expect(t.lines.map((l) => l.cartDiscount)).toEqual([T(300), T(150)]);
    expect(t.discountTotal).toBe(T(300) + T(450));
    expect(t.total).toBe(T(4050));
  });

  it("voided lines are excluded", () => {
    const t = computeTotals(
      run([add("a", "milk"), add("b", "beer"), { type: "VOID_LINE", lineId: "a" }]),
      catalog,
    );
    expect(t.lines[0]).toMatchObject({ voided: true, gross: 0n });
    expect(t.total).toBe(T(5000));
  });

  it("rounds the payable, keeping tax unchanged", () => {
    // 3 × 3.33₮ -ish: use override to get a möngö-level total
    const cart = run([
      add("a", "milk"),
      { type: "SET_PRICE_OVERRIDE", lineId: "a", price: 3333_33n },
    ]);
    const t = computeTotals(cart, catalog);
    expect(t.total).toBe(3333_33n);
    expect(t.payable).toBe(3333_00n);
    expect(t.roundingAmount).toBe(-33n);
    expect(t.vatTotal).toBe(t.lines[0]!.vat);
    const t5 = computeTotals(cart, catalog, { totalRoundingUnit: 500n });
    expect(t5.payable).toBe(3335_00n);
    expect(t5.total + t5.roundingAmount).toBe(t5.payable);
  });

  it("throws on a variant missing from the catalog", () => {
    const cart = run([add("a", "milk")]);
    expect(() => computeTotals(cart, { variants: {} })).toThrow(CartError);
  });

  it("is deterministic and independent of action history", () => {
    const a = run([add("a", "milk"), add("b", "beer")]);
    const b = run([add("b", "beer"), add("a", "milk")]);
    expect(computeTotals(a, catalog).total).toBe(computeTotals(b, catalog).total);
    expect(computeTotals(a, catalog)).toEqual(computeTotals(a, catalog));
  });
});

describe("requiredApprovals", () => {
  const pct = (percentBps: number) => ({ kind: "PERCENT" as const, percentBps });
  it("none for plain carts and small discounts", () => {
    const cart = run([
      add("a", "milk"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: pct(1000) },
    ]);
    expect(requiredApprovals(cart, catalog)).toEqual([]);
  });

  it("price overrides always need approval; an equal price does not", () => {
    const cart = run([
      add("a", "milk"),
      { type: "SET_PRICE_OVERRIDE", lineId: "a", price: T(3000) },
    ]);
    expect(requiredApprovals(cart, catalog)).toEqual([
      {
        key: "line:a:price",
        kind: "PRICE_OVERRIDE",
        permission: "pos.price_override",
        scope: "LINE",
        lineId: "a",
      },
    ]);
    const same = run([{ type: "SET_PRICE_OVERRIDE", lineId: "a", price: T(3300) }], cart);
    expect(requiredApprovals(same, catalog)).toEqual([]);
  });

  it("large line and cart discounts, keyed by index; voided lines excluded", () => {
    const cart = run([
      add("a", "milk"),
      add("b", "beer"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: pct(500) },
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: pct(2000) },
      { type: "ADD_LINE_DISCOUNT", lineId: "b", discount: pct(5000) },
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "FIXED", amount: T(2000) } },
      { type: "VOID_LINE", lineId: "b" },
    ]);
    expect(requiredApprovals(cart, catalog).map((r) => r.key)).toEqual([
      "line:a:discount:1",
      "cart:discount:0",
    ]);
  });
});

describe("properties (seeded)", () => {
  it("random carts: sums reconcile, nothing negative, discounts bounded", () => {
    let seed = 20260101;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const ids = ["milk", "bread", "beer", "tomato", "excl"];
    for (let i = 0; i < 400; i++) {
      let cart = EMPTY_CART;
      const n = 1 + (next() % 6);
      for (let j = 0; j < n; j++) {
        const id = ids[next() % ids.length]!;
        const fractional = id === "tomato";
        const qtyMilli = fractional ? 1 + (next() % 5000) : 1000 * (1 + (next() % 4));
        cart = run(
          [{ type: "ADD_ITEM", lineId: `l${j}`, variantId: id, qtyMilli, merge: false }],
          cart,
        );
        if (next() % 3 === 0) {
          cart = run(
            [{ type: "SET_PRICE_OVERRIDE", lineId: `l${j}`, price: BigInt(next() % 900_000) }],
            cart,
          );
        }
        for (let k = next() % 3; k > 0; k--) {
          cart = run(
            [
              {
                type: "ADD_LINE_DISCOUNT",
                lineId: `l${j}`,
                discount:
                  next() % 2
                    ? { kind: "PERCENT", percentBps: 1 + (next() % 10_000) }
                    : { kind: "FIXED", amount: BigInt(1 + (next() % 500_000)) },
              },
            ],
            cart,
          );
        }
      }
      for (let k = next() % 3; k > 0; k--) {
        cart = run(
          [
            {
              type: "APPLY_CART_DISCOUNT",
              discount:
                next() % 2
                  ? { kind: "PERCENT", percentBps: 1 + (next() % 10_000) }
                  : { kind: "FIXED", amount: BigInt(1 + (next() % 900_000)) },
            },
          ],
          cart,
        );
      }
      const unit = [1n, 100n, 500n, 1000n][next() % 4]!;
      const t = computeTotals(cart, catalog, { totalRoundingUnit: unit });
      let gross = 0n;
      for (const l of t.lines) {
        expect(l.net + l.vat + l.city).toBe(l.gross);
        expect(l.net >= 0n && l.vat >= 0n && l.city >= 0n && l.gross >= 0n).toBe(true);
        expect(l.discount).toBe(l.lineDiscount + l.cartDiscount);
        expect(l.discount <= l.subtotal).toBe(true);
        gross += l.gross;
      }
      expect(t.total).toBe(gross);
      expect(t.netTotal + t.taxTotal).toBe(t.total);
      expect(t.total + t.roundingAmount).toBe(t.payable);
      expect(t.payable % unit).toBe(0n);
      expect(t.discountTotal).toBe(t.lines.reduce((a, l) => a + l.discount, 0n));
    }
  });
});

describe("review regressions", () => {
  it("ADD_ITEM does not merge into a line with override, discount or note", () => {
    const over = run([
      add("a", "milk"),
      { type: "SET_PRICE_OVERRIDE", lineId: "a", price: 100n },
      add("b", "milk"),
    ]);
    expect(over.lines).toHaveLength(2);
    const disc = run([
      add("a", "milk"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "PERCENT", percentBps: 5000 } },
      add("b", "milk"),
    ]);
    expect(disc.lines).toHaveLength(2);
    const noted = run([
      add("a", "milk"),
      { type: "SET_NOTE", lineId: "a", note: "x" },
      add("b", "milk"),
    ]);
    expect(noted.lines).toHaveLength(2);
    expect(computeTotals(over, catalog).total).toBe(100n + T(3300));
  });

  it("fixed cart discount takes the same gross off exclusive and inclusive lines", () => {
    const cart = run([
      add("a", "excl", 10),
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "FIXED", amount: T(1000) } },
    ]);
    const before = computeTotals({ ...cart, discounts: [] }, catalog).total;
    expect(before).toBe(T(11000));
    expect(computeTotals(cart, catalog).total).toBe(T(10000));
    const mixed = run([
      add("a", "excl", 10),
      add("b", "milk", 1),
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "FIXED", amount: T(1000) } },
    ]);
    const t = computeTotals(mixed, catalog);
    const base = computeTotals({ ...mixed, discounts: [] }, catalog);
    const drop = base.total - t.total;
    expect(drop >= T(1000) - 1n && drop <= T(1000) + 1n).toBe(true);
  });

  it("computeTotalsDetailed exposes per-step discounts", () => {
    const cart = run([
      add("a", "milk"),
      { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "PERCENT", percentBps: 1000 } },
      { type: "APPLY_CART_DISCOUNT", discount: { kind: "FIXED", amount: T(100) } },
    ]);
    const d = computeTotalsDetailed(cart, catalog);
    expect(d.lineSteps.get("a")).toHaveLength(1);
    expect(d.cartSteps).toHaveLength(1);
  });
});
