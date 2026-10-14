import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeTotals, type CatalogSnapshot } from "./cart";
import {
  CHECKOUT_ERROR_CODES,
  CHECKOUT_ERROR_MESSAGE_KEYS,
  cartFromCheckoutInput,
  checkoutErrorFromTender,
  checkoutFingerprint,
  checkoutInputSchema,
  checkoutResultSchema,
  isSameCheckout,
  lineIntentsFromCart,
  sha256Hex,
  stableStringify,
  toWire,
  type CheckoutInput,
} from "./checkout-contract";
import { fromMajor } from "./money";
import { buildScaleBarcode, DEFAULT_SCALE_RULES } from "./scale-barcode";

const T = fromMajor;
const SALE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const L1 = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01";
const L2 = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02";
const V1 = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01";
const V2 = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02";

const catalog: CatalogSnapshot = {
  variants: {
    [V1]: {
      variantId: V1,
      unit: "PIECE",
      price: T(3300),
      pricesIncludeTax: true,
      taxTreatment: "STANDARD",
      vatRateBps: 1000,
      cityTaxRateBps: 0,
    },
    [V2]: {
      variantId: V2,
      unit: "KG",
      price: T(6000),
      pricesIncludeTax: true,
      taxTreatment: "STANDARD",
      vatRateBps: 1000,
      cityTaxRateBps: 0,
      pluCode: "123",
    },
  },
};

const wire = () => ({
  saleId: SALE,
  lines: [
    { lineId: L1, variantId: V1, qtyMilli: 2000, listedUnitPrice: "330000" },
    { lineId: L2, variantId: V2, qtyMilli: 500, discounts: [{ kind: "PERCENT", percentBps: 500 }] },
  ],
  tenders: [{ method: "CASH", amount: "960000", tendered: "1000000" }],
  expectedPayable: "960000",
  approvals: { "line:x:price": "tok" },
  createdAtClient: "2026-10-14T09:30:00+08:00",
});
const parse = (over: Record<string, unknown> = {}): CheckoutInput =>
  checkoutInputSchema.parse({ ...wire(), ...over });

describe("sha256Hex", () => {
  it("matches known vectors and node:crypto across lengths", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    for (let n = 0; n < 200; n += 7) {
      const s = "é₮x".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});

describe("checkoutInputSchema", () => {
  it("parses money strings into bigint and applies defaults", () => {
    const input = parse();
    expect(input.lines[0]?.listedUnitPrice).toBe(330000n);
    expect(input.lines[0]?.discounts).toEqual([]);
    expect(input.cartDiscounts).toEqual([]);
    expect(input.tenders[0]).toMatchObject({ amount: 960000n, tendered: 1000000n });
  });

  it("requires a UUIDv7 sale id", () => {
    expect(
      checkoutInputSchema.safeParse({ ...wire(), saleId: "0190a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b" })
        .success,
    ).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...wire(), saleId: "nope" }).success).toBe(false);
  });

  it("a line is a variant OR a scale barcode", () => {
    const base = wire();
    const bad = [
      { lineId: L1 },
      { lineId: L1, variantId: V1 },
      { lineId: L1, variantId: V1, scaleBarcode: "2000123012507", qtyMilli: 1000 },
    ];
    for (const line of bad) {
      expect(checkoutInputSchema.safeParse({ ...base, lines: [line] }).success).toBe(false);
    }
    const ok = { lineId: L1, scaleBarcode: "2000123012507" };
    expect(checkoutInputSchema.safeParse({ ...base, lines: [ok] }).success).toBe(true);
  });

  it("rejects empty carts, bad money, zero tenders, bad dates", () => {
    expect(checkoutInputSchema.safeParse({ ...wire(), lines: [] }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...wire(), expectedPayable: "-1" }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...wire(), expectedPayable: "1.5" }).success).toBe(
      false,
    );
    expect(
      checkoutInputSchema.safeParse({ ...wire(), tenders: [{ method: "CASH", amount: "0" }] })
        .success,
    ).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...wire(), createdAtClient: "yesterday" }).success).toBe(
      false,
    );
    expect(
      checkoutInputSchema.safeParse({ ...wire(), tenders: [{ method: "BITCOIN", amount: "1" }] })
        .success,
    ).toBe(false);
  });

  it("allows a zero-value sale with no tenders", () => {
    expect(
      checkoutInputSchema.safeParse({ ...wire(), tenders: [], expectedPayable: "0" }).success,
    ).toBe(true);
  });
});

describe("error codes", () => {
  it("has the documented codes with message keys", () => {
    for (const code of [
      "STALE_PRICE",
      "INSUFFICIENT_STOCK",
      "SHIFT_REQUIRED",
      "APPROVAL_REQUIRED",
      "TENDER_MISMATCH",
    ]) {
      expect(CHECKOUT_ERROR_CODES).toContain(code);
    }
    for (const code of CHECKOUT_ERROR_CODES) {
      expect(CHECKOUT_ERROR_MESSAGE_KEYS[code]).toBe(`checkout.errors.${code}`);
    }
    expect(new Set(CHECKOUT_ERROR_CODES).size).toBe(CHECKOUT_ERROR_CODES.length);
  });
});

describe("fingerprint", () => {
  it("is stable under key order, ignores approvals and the client clock", () => {
    const a = parse();
    const reordered = checkoutInputSchema.parse(
      Object.fromEntries(Object.entries(wire()).reverse()),
    );
    expect(checkoutFingerprint(reordered)).toBe(checkoutFingerprint(a));
    const retried = parse({
      approvals: { other: "fresh" },
      createdAtClient: "2026-10-14T09:31:00+08:00",
    });
    expect(isSameCheckout(checkoutFingerprint(a), retried)).toBe(true);
  });

  it("changes when anything that matters changes", () => {
    const base = checkoutFingerprint(parse());
    const w = wire();
    const variants: Record<string, unknown>[] = [
      { lines: [{ ...w.lines[0]!, qtyMilli: 3000 }, w.lines[1]!] },
      { lines: [w.lines[1]!, w.lines[0]!] },
      { lines: [w.lines[0]!, { ...w.lines[1]!, discounts: [] }] },
      { tenders: [{ method: "CARD", amount: "960000" }] },
      { tenders: [{ method: "CASH", amount: "960000", tendered: "2000000" }] },
      { expectedPayable: "960100" },
      { cartDiscounts: [{ kind: "FIXED", amount: "100" }] },
      { note: "x" },
      { customerId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01" },
    ];
    for (const over of variants) expect(checkoutFingerprint(parse(over))).not.toBe(base);
  });

  it("stableStringify distinguishes bigint from number and drops undefined", () => {
    expect(stableStringify({ b: 1n, a: [undefined, 2] })).toBe('{"a":[null,2],"b":"1n"}');
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("cartFromCheckoutInput", () => {
  it("rebuilds the cart from DB prices and matches client totals", () => {
    const r = cartFromCheckoutInput(parse(), catalog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cart.lines.map((l) => l.lineId)).toEqual([L1, L2]);
    // 2 × 3300 + 0.5 × 6000 × 0.95 = 6600 + 2850
    expect(computeTotals(r.cart, catalog).total).toBe(T(9450));
  });

  it("keeps duplicate piece intents as separate lines", () => {
    const input = parse({
      lines: [
        { lineId: L1, variantId: V1, qtyMilli: 1000 },
        { lineId: L2, variantId: V1, qtyMilli: 1000 },
      ],
    });
    const r = cartFromCheckoutInput(input, catalog);
    expect(r.ok && r.cart.lines.length).toBe(2);
  });

  it("flags a stale client price", () => {
    const input = parse({
      lines: [{ lineId: L1, variantId: V1, qtyMilli: 1000, listedUnitPrice: "300000" }],
    });
    const r = cartFromCheckoutInput(input, catalog);
    expect(r).toMatchObject({ ok: false, error: { code: "STALE_PRICE", details: { lineId: L1 } } });
  });

  it("maps cart errors to checkout codes", () => {
    const unknown = parse({
      lines: [{ lineId: L1, variantId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4bff", qtyMilli: 1000 }],
    });
    expect(cartFromCheckoutInput(unknown, catalog)).toMatchObject({
      error: { code: "VARIANT_NOT_FOUND" },
    });
    const frac = parse({ lines: [{ lineId: L1, variantId: V1, qtyMilli: 1500 }] });
    expect(cartFromCheckoutInput(frac, catalog)).toMatchObject({
      error: { code: "INVALID_QUANTITY" },
    });
  });

  it("resolves scale barcodes server-side and rejects a conflicting qty", () => {
    const code = buildScaleBarcode(DEFAULT_SCALE_RULES[0]!, "123", 1250);
    const ok = cartFromCheckoutInput(
      parse({ lines: [{ lineId: L1, scaleBarcode: code }] }),
      catalog,
    );
    expect(ok.ok && ok.cart.lines[0]?.qtyMilli).toBe(1250);
    const bad = cartFromCheckoutInput(
      parse({ lines: [{ lineId: L1, scaleBarcode: code, qtyMilli: 999 }] }),
      catalog,
    );
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_QUANTITY" } });
  });

  it("client cart → intents → server cart round-trips", () => {
    const server = cartFromCheckoutInput(parse(), catalog);
    if (!server.ok) throw new Error("setup");
    const intents = lineIntentsFromCart(server.cart);
    const again = cartFromCheckoutInput(
      parse({ lines: JSON.parse(JSON.stringify(intents)) }),
      catalog,
    );
    expect(again.ok && computeTotals(again.cart, catalog)).toEqual(
      computeTotals(server.cart, catalog),
    );
  });
});

describe("result", () => {
  it("serializes bigint to strings and parses them back", () => {
    const result = {
      saleId: SALE,
      receiptNumber: "UB1-000123",
      status: "COMPLETED" as const,
      totals: {
        subtotal: 1n,
        discountTotal: 0n,
        netTotal: 1n,
        vatTotal: 0n,
        cityTotal: 0n,
        total: 1n,
        roundingAmount: -50n,
        payable: 0n,
      },
      payments: [{ method: "CASH" as const, amount: 100n, tendered: 200n, change: 100n }],
      change: 100n,
      shareToken: "tok",
      replayed: false,
    };
    const json = JSON.stringify(toWire(result));
    expect(checkoutResultSchema.parse(JSON.parse(json))).toEqual(result);
  });
});

describe("review regressions", () => {
  const issues = (over: Record<string, unknown>) => {
    const r = checkoutInputSchema.safeParse({ ...wire(), ...over });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };

  it("uppercase UUIDs fingerprint like lowercase", () => {
    const upper = parse({
      saleId: SALE.toUpperCase(),
      lines: [
        {
          lineId: L1.toUpperCase(),
          variantId: V1.toUpperCase(),
          qtyMilli: 2000,
          listedUnitPrice: "330000",
        },
        {
          lineId: L2,
          variantId: V2,
          qtyMilli: 500,
          discounts: [{ kind: "PERCENT", percentBps: 500 }],
        },
      ],
    });
    expect(checkoutFingerprint(upper)).toBe(checkoutFingerprint(parse()));
  });

  it("empty optional strings equal absent ones", () => {
    expect(checkoutFingerprint(parse({ note: "" }))).toBe(checkoutFingerprint(parse()));
    expect(checkoutFingerprint(parse({ note: "   " }))).toBe(checkoutFingerprint(parse()));
  });

  it("rejects lone surrogates", () => {
    expect(issues({ note: "a\ud800" })).toContain("note");
    expect(issues({ note: "ok \ud83d\ude00" })).toEqual([]);
  });

  it("rejects duplicate lineIds", () => {
    const line = { lineId: L1, variantId: V1, qtyMilli: 1000 };
    expect(issues({ lines: [line, line] })).toContain("lines.1.lineId");
  });

  it("caps the approvals record", () => {
    const approvals = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "t"]));
    expect(issues({ approvals })).toContain("approvals");
  });

  it("cross-validates tenders by method", () => {
    const PI = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01";
    const t = (o: Record<string, unknown>) => ({ method: "CASH", amount: "100", ...o });
    expect(issues({ tenders: [t({ method: "QPAY" })] })).toContain("tenders.0.paymentIntentId");
    expect(issues({ tenders: [t({ method: "GIFT_CARD" })] })).toContain("tenders.0.giftCardCode");
    expect(issues({ tenders: [t({ method: "CARD", giftCardCode: "G1" })] })).toContain(
      "tenders.0.giftCardCode",
    );
    expect(issues({ tenders: [t({ method: "STORE_CREDIT" })] })).toContain("customerId");
    expect(
      issues({
        tenders: [
          t({ method: "GIFT_CARD", giftCardCode: "ab" }),
          t({ method: "GIFT_CARD", giftCardCode: "AB" }),
        ],
      }),
    ).toContain("tenders.1.giftCardCode");
    expect(
      issues({
        tenders: [
          t({ method: "QPAY", paymentIntentId: PI }),
          t({ method: "QPAY", paymentIntentId: PI.toUpperCase() }),
        ],
      }),
    ).toContain("tenders.1.paymentIntentId");
    expect(issues({ tenders: [t({ method: "QPAY", paymentIntentId: PI })] })).toEqual([]);
  });

  it("maps tender issues to specific codes", () => {
    expect(checkoutErrorFromTender([{ code: "UNDERPAID" }]).code).toBe("TENDER_UNDERPAID");
    expect(checkoutErrorFromTender([{ code: "OVERPAID", index: 0 }]).code).toBe("TENDER_OVERPAID");
    expect(checkoutErrorFromTender([{ code: "TOO_MANY_TENDERS" }]).code).toBe("TENDER_MISMATCH");
  });
});
