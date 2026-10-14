import { describe, expect, it } from "vitest";
import { computeTotals, requiredApprovals } from "@/domain/cart";
import { DEFAULT_APPROVAL_POLICY } from "@/domain/discounts";
import { snapshotOf, type CatalogEntry } from "./catalog-entry";
import {
  APPROVAL_CLIENT_TTL_MS,
  approvalFingerprint,
  approvalTokens,
  createPosReducer,
  initialPosState,
  pendingApprovals,
  totalsOf,
  type ApprovalGrant,
  type PosAction,
  type PosConfig,
  type PosState,
} from "./pos-state";

const config: PosConfig = { totalRoundingUnit: 100n };
const reduce = createPosReducer(config);

const coffee: CatalogEntry = {
  variantId: "v-coffee",
  productId: "p-coffee",
  label: "Coffee",
  sku: "COF",
  barcode: "8650001000019",
  unit: "PIECE",
  price: 500_000n, // 5 000₮, VAT-inclusive
  pricesIncludeTax: true,
  taxTreatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
  pluCode: null,
  categoryId: null,
  productType: "STANDARD",
  onHandMilli: null,
};
const apples: CatalogEntry = {
  ...coffee,
  variantId: "v-apple",
  productId: "p-apple",
  label: "Apples",
  unit: "KG",
  price: 400_000n, // 4 000₮ per kg
  pluCode: "12301",
};

function run(actions: PosAction[], from = initialPosState("sale-1")): PosState {
  return actions.reduce(reduce, from);
}
const add = (entry: CatalogEntry, qtyMilli: number, lineId: string): PosAction => ({
  type: "add",
  entry,
  qtyMilli,
  lineId,
});
const grant = (state: PosState, key: string, at = 1000): ApprovalGrant => {
  const requirement = requiredApprovals(
    state.cart,
    snapshotOf(state.entries),
    DEFAULT_APPROVAL_POLICY,
    { totalRoundingUnit: 100n },
  ).find((r) => r.key === key)!;
  return {
    token: `token-${key}`,
    fingerprint: approvalFingerprint(requirement),
    approverName: "Manager",
    grantedAt: at,
  };
};

describe("register state", () => {
  it("adds pieces, merges the same item and prices with the domain totals", () => {
    const state = run([add(coffee, 1000, "a"), add(coffee, 2000, "b")]);
    expect(state.cart.lines).toHaveLength(1);
    expect(state.cart.lines[0]?.qtyMilli).toBe(3000);
    const totals = totalsOf(state, config);
    expect(totals.total).toBe(1_500_000n);
    expect(totals.payable).toBe(1_500_000n);
    // VAT-inclusive 15 000₮ at 10%: 15 000 * 1000 / 11 000 = 1 363.64₮
    expect(totals.vatTotal).toBe(136_364n);
    expect(totals).toEqual(
      computeTotals(state.cart, snapshotOf(state.entries), { totalRoundingUnit: 100n }),
    );
  });

  it("weighed items take decimals and add a new line each time", () => {
    const state = run([add(apples, 1250, "a"), add(apples, 500, "b")]);
    expect(state.cart.lines.map((l) => l.qtyMilli)).toEqual([1250, 500]);
    expect(totalsOf(state, config).total).toBe(700_000n); // 1.75kg * 4 000₮ = 7 000₮
  });

  it("ignores invalid actions (fractional pieces) instead of corrupting the cart", () => {
    const state = run([add(coffee, 1000, "a"), add(coffee, 1500, "b")]);
    expect(state.cart.lines[0]?.qtyMilli).toBe(1000);
  });

  it("SET_QTY, VOID, REMOVE and CLEAR go through the domain reducer", () => {
    let state = run([add(coffee, 1000, "a"), add(apples, 1000, "b")]);
    state = run(
      [{ type: "cart", action: { type: "SET_QTY", lineId: "a", qtyMilli: 4000 } }],
      state,
    );
    expect(state.cart.lines[0]?.qtyMilli).toBe(4000);
    state = run([{ type: "cart", action: { type: "VOID_LINE", lineId: "b" } }], state);
    expect(totalsOf(state, config).total).toBe(2_000_000n);
    state = run([{ type: "cart", action: { type: "REMOVE_LINE", lineId: "b" } }], state);
    expect(state.cart.lines).toHaveLength(1);
    state = run([{ type: "cart", action: { type: "CLEAR" } }], state);
    expect(state.cart.lines).toHaveLength(0);
    expect(state.saleId).toBe("sale-1"); // nothing was sold: same sale
  });

  it("a scale label adds the weighed line from the PLU", () => {
    // 20 | 12301 | 01250 (1.250 kg) | check digit
    const first12 = "201230101250";
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    const barcode = first12 + String((10 - (sum % 10)) % 10);
    const state = run([{ type: "addScale", entry: apples, barcode, lineId: "s" }]);
    expect(state.cart.lines[0]?.qtyMilli).toBe(1250);
    expect(state.cart.lines[0]?.scaleBarcode).toBe(barcode);
  });

  it("reset starts a new sale with a new id and an empty cart", () => {
    const state = run([add(coffee, 1000, "a"), { type: "reset", saleId: "sale-2" }]);
    expect(state.saleId).toBe("sale-2");
    expect(state.cart.lines).toHaveLength(0);
    expect(Object.keys(state.entries)).toHaveLength(0);
  });
});

describe("manager approvals", () => {
  const discount = (percentBps: number): PosAction => ({
    type: "cart",
    action: { type: "ADD_LINE_DISCOUNT", lineId: "a", discount: { kind: "PERCENT", percentBps } },
  });

  it("a discount up to 10% needs no approval, above it a cashier needs one", () => {
    const small = run([add(coffee, 1000, "a"), discount(1000)]);
    expect(pendingApprovals(small, config, "CASHIER", 0)).toEqual([]);
    const big = run([add(coffee, 1000, "a"), discount(1500)]);
    const pending = pendingApprovals(big, config, "CASHIER", 0);
    expect(pending.map((p) => p.key)).toEqual(["line:a:discount:0"]);
    expect(pending[0]?.permission).toBe("pos.discount.manual");
  });

  it("managers and owners approve themselves", () => {
    const big = run([add(coffee, 1000, "a"), discount(5000)]);
    expect(pendingApprovals(big, config, "MANAGER", 0)).toEqual([]);
    expect(pendingApprovals(big, config, "OWNER", 0)).toEqual([]);
  });

  it("a price override always needs approval", () => {
    const state = run([
      add(coffee, 1000, "a"),
      { type: "cart", action: { type: "SET_PRICE_OVERRIDE", lineId: "a", price: 400_000n } },
    ]);
    const pending = pendingApprovals(state, config, "CASHIER", 0);
    expect(pending.map((p) => p.key)).toEqual(["line:a:price"]);
    expect(pending[0]?.permission).toBe("pos.price_override");
  });

  it("an approval clears the requirement and travels as a token by key", () => {
    const base = run([add(coffee, 1000, "a"), discount(2000)]);
    const approved = run(
      [{ type: "approve", grants: { "line:a:discount:0": grant(base, "line:a:discount:0") } }],
      base,
    );
    expect(pendingApprovals(approved, config, "CASHIER", 2000)).toEqual([]);
    expect(approvalTokens(approved, config)).toEqual({
      "line:a:discount:0": "token-line:a:discount:0",
    });
  });

  it("changing the approved discount invalidates its approval", () => {
    const base = run([add(coffee, 1000, "a"), discount(2000)]);
    const approved = run(
      [{ type: "approve", grants: { "line:a:discount:0": grant(base, "line:a:discount:0") } }],
      base,
    );
    // Clear and re-apply a deeper discount under the same key.
    const changed = run(
      [{ type: "cart", action: { type: "CLEAR_LINE_DISCOUNTS", lineId: "a" } }, discount(9000)],
      approved,
    );
    expect(Object.keys(changed.approvals)).toEqual([]);
    expect(pendingApprovals(changed, config, "CASHIER", 2000).map((p) => p.key)).toEqual([
      "line:a:discount:0",
    ]);
  });

  it("removing the discount drops the grant", () => {
    const base = run([add(coffee, 1000, "a"), discount(2000)]);
    const approved = run(
      [{ type: "approve", grants: { "line:a:discount:0": grant(base, "line:a:discount:0") } }],
      base,
    );
    const cleared = run(
      [{ type: "cart", action: { type: "CLEAR_LINE_DISCOUNTS", lineId: "a" } }],
      approved,
    );
    expect(cleared.approvals).toEqual({});
    expect(approvalTokens(cleared, config)).toEqual({});
  });

  it("an approval expires before the server's token does", () => {
    const base = run([add(coffee, 1000, "a"), discount(2000)]);
    const approved = run(
      [{ type: "approve", grants: { "line:a:discount:0": grant(base, "line:a:discount:0", 0) } }],
      base,
    );
    expect(pendingApprovals(approved, config, "CASHIER", APPROVAL_CLIENT_TTL_MS - 1)).toEqual([]);
    expect(pendingApprovals(approved, config, "CASHIER", APPROVAL_CLIENT_TTL_MS)).toHaveLength(1);
  });

  it("cart discounts are keyed cart:discount:<i>", () => {
    const state = run([
      add(coffee, 1000, "a"),
      {
        type: "cart",
        action: { type: "APPLY_CART_DISCOUNT", discount: { kind: "PERCENT", percentBps: 2000 } },
      },
    ]);
    expect(pendingApprovals(state, config, "CASHIER", 0).map((p) => p.key)).toEqual([
      "cart:discount:0",
    ]);
  });
});

describe("repricing after STALE_PRICE", () => {
  it("takes the catalog price, keeps quantity and discounts, recomputes totals", () => {
    const base = run([
      add(coffee, 2000, "a"),
      {
        type: "cart",
        action: {
          type: "ADD_LINE_DISCOUNT",
          lineId: "a",
          discount: { kind: "PERCENT", percentBps: 1000 },
        },
      },
    ]);
    const next = run([{ type: "reprice", entries: [{ ...coffee, price: 600_000n }] }], base);
    expect(next.cart.lines[0]?.unitPrice).toBe(600_000n);
    expect(next.cart.lines[0]?.qtyMilli).toBe(2000);
    expect(next.cart.lines[0]?.discounts).toHaveLength(1);
    expect(totalsOf(next, config).total).toBe(1_080_000n); // 12 000₮ - 10%
  });
});
