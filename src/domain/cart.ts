/**
 * Pure cart model + reducer + totals. Used by BOTH the browser (instant,
 * optimistic totals) and the server (authoritative recomputation from DB
 * prices). Deterministic: every input is explicit, no clock, no randomness.
 * Line ids are supplied by the caller (the UI generates them).
 *
 * Order of operations in `computeTotals` (see docs/checkout-domain.md):
 *   1. base       = labelTotal ?? extend(priceOverride ?? unitPrice, qty)
 *   2. line discounts, sequentially            (discounts.ts)
 *   3. cart discounts, pro-rata, largest remainder
 *   4. tax per line on what remains            (tax.ts)
 *   5. total = Σ gross;  payable = round(total) with signed roundingAmount
 */
import {
  DEFAULT_APPROVAL_POLICY,
  applyCartDiscounts,
  applyDiscountsSequentially,
  approvalKeys,
  discountNeedsApproval,
  isValidDiscountRequest,
  type ApprovalPolicy,
  type ApprovalRequirement,
  type DiscountRequest,
} from "./discounts";
import { MAX_MONEY } from "./catalog";
import { sum, type Money } from "./money";
import { MAX_QTY_MILLI, extend, isFractionalUnit, isValidQty, type Unit } from "./qty";
import { DEFAULT_ROUNDING_UNIT, roundTotal } from "./rounding";
import { DEFAULT_SCALE_RULES, normalizePlu, parseScaleBarcode } from "./scale-barcode";
import type { ScaleBarcodeRule } from "./scale-barcode";
import { computeLineTax, type TaxTreatment } from "./tax";

export const MAX_CART_LINES = 200;
export const MAX_LINE_DISCOUNTS = 5;
export const MAX_CART_DISCOUNTS = 3;
export const MAX_NOTE_LENGTH = 200;

/** What the cart needs to know about a variant (price/tax as of "now"). */
export interface CatalogVariant {
  variantId: string;
  productId?: string;
  name?: string;
  unit: Unit;
  /** Listed unit price (per unit of `unit`), in the product's tax mode. */
  price: Money;
  pricesIncludeTax: boolean;
  taxTreatment: TaxTreatment;
  vatRateBps: number;
  cityTaxRateBps: number;
  /** Scale PLU (normalized, no leading zeros) for scale-label lookup. */
  pluCode?: string | null;
}

export interface CatalogSnapshot {
  variants: Readonly<Record<string, CatalogVariant>>;
}

export interface CartSettings {
  /** BusinessSettings.totalRoundingUnit (möngö). Default 100. */
  totalRoundingUnit?: Money;
}

export interface CartLine {
  lineId: string;
  variantId: string;
  qtyMilli: number;
  /** Listed price at the time the line was added (per unit). */
  unitPrice: Money;
  /** Requested price override (needs approval). */
  priceOverride?: Money;
  discounts: DiscountRequest[];
  note?: string;
  /** Voided lines stay for audit/UI but are excluded from every total. */
  voided?: boolean;
  /** Scale label this line came from (server re-parses it). */
  scaleBarcode?: string;
  /** Price-embedded scale label: the label's exact line price. */
  labelTotal?: Money;
}

export interface Cart {
  lines: CartLine[];
  discounts: DiscountRequest[];
}

export const EMPTY_CART: Cart = { lines: [], discounts: [] };

export type CartErrorCode =
  | "UNKNOWN_VARIANT"
  | "INVALID_QUANTITY"
  | "INVALID_PRICE"
  | "INVALID_DISCOUNT"
  | "INVALID_SCALE_BARCODE"
  | "LINE_NOT_FOUND"
  | "DUPLICATE_LINE_ID"
  | "CART_FULL"
  | "NOTE_TOO_LONG";

export class CartError extends Error {
  constructor(
    readonly code: CartErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CartError";
  }
}

export type CartAction =
  | {
      type: "ADD_ITEM";
      lineId: string;
      variantId: string;
      qtyMilli: number;
      /** Merge into an existing plain line of the same piece variant. Default true. */
      merge?: boolean;
    }
  | { type: "ADD_SCALE"; lineId: string; barcode: string; rules?: readonly ScaleBarcodeRule[] }
  | { type: "SET_QTY"; lineId: string; qtyMilli: number }
  | { type: "REMOVE_LINE"; lineId: string }
  | { type: "VOID_LINE"; lineId: string }
  | { type: "SET_PRICE_OVERRIDE"; lineId: string; price: Money | null }
  | { type: "ADD_LINE_DISCOUNT"; lineId: string; discount: DiscountRequest }
  | { type: "CLEAR_LINE_DISCOUNTS"; lineId: string }
  | { type: "SET_NOTE"; lineId: string; note: string | null }
  | { type: "APPLY_CART_DISCOUNT"; discount: DiscountRequest }
  | { type: "CLEAR_CART_DISCOUNTS" }
  | { type: "CLEAR" };

export type CartResult = { ok: true; cart: Cart } | { ok: false; error: CartError };

function variantOf(catalog: CatalogSnapshot, variantId: string): CatalogVariant {
  const variant = catalog.variants[variantId];
  if (!variant) throw new CartError("UNKNOWN_VARIANT", `unknown variant ${variantId}`);
  return variant;
}

function findLine(cart: Cart, lineId: string): CartLine {
  const line = cart.lines.find((l) => l.lineId === lineId);
  if (!line) throw new CartError("LINE_NOT_FOUND", `no line ${lineId}`);
  return line;
}

function replaceLine(cart: Cart, lineId: string, update: (line: CartLine) => CartLine): Cart {
  findLine(cart, lineId);
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? update(l) : l)) };
}

function assertNewLine(cart: Cart, lineId: string): void {
  if (cart.lines.some((l) => l.lineId === lineId)) throw new CartError("DUPLICATE_LINE_ID");
  if (cart.lines.length >= MAX_CART_LINES) throw new CartError("CART_FULL");
}

function assertMoney(value: Money, code: CartErrorCode = "INVALID_PRICE"): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_MONEY) throw new CartError(code);
}

function assertDiscount(d: DiscountRequest): void {
  if (!isValidDiscountRequest(d)) throw new CartError("INVALID_DISCOUNT");
  if (d.kind === "FIXED" && d.amount > MAX_MONEY) throw new CartError("INVALID_DISCOUNT");
}

/**
 * Apply one action. Never mutates. Piece items merge into an existing plain
 * line of the same variant; weighed/measured items always add a new line.
 */
export function reduceCart(cart: Cart, action: CartAction, catalog: CatalogSnapshot): CartResult {
  try {
    return { ok: true, cart: applyAction(cart, action, catalog) };
  } catch (error) {
    if (error instanceof CartError) return { ok: false, error };
    throw error;
  }
}

/** Convenience for `useReducer`: invalid actions leave the cart unchanged. */
export function cartReducer(cart: Cart, action: CartAction, catalog: CatalogSnapshot): Cart {
  const result = reduceCart(cart, action, catalog);
  return result.ok ? result.cart : cart;
}

function applyAction(cart: Cart, action: CartAction, catalog: CatalogSnapshot): Cart {
  switch (action.type) {
    case "ADD_ITEM": {
      const variant = variantOf(catalog, action.variantId);
      if (!isValidQty(action.qtyMilli, variant.unit)) throw new CartError("INVALID_QUANTITY");
      assertMoney(variant.price);
      if (!isFractionalUnit(variant.unit) && action.merge !== false) {
        const existing = cart.lines.find(
          (l) =>
            !l.voided &&
            l.variantId === variant.variantId &&
            l.labelTotal === undefined &&
            l.unitPrice === variant.price,
        );
        if (existing) {
          const merged = existing.qtyMilli + action.qtyMilli;
          if (!isValidQty(merged, variant.unit)) throw new CartError("INVALID_QUANTITY");
          return replaceLine(cart, existing.lineId, (l) => ({ ...l, qtyMilli: merged }));
        }
      }
      assertNewLine(cart, action.lineId);
      const line: CartLine = {
        lineId: action.lineId,
        variantId: variant.variantId,
        qtyMilli: action.qtyMilli,
        unitPrice: variant.price,
        discounts: [],
      };
      return { ...cart, lines: [...cart.lines, line] };
    }
    case "ADD_SCALE": {
      const match = parseScaleBarcode(action.barcode, action.rules ?? DEFAULT_SCALE_RULES);
      if (!match) throw new CartError("INVALID_SCALE_BARCODE");
      const variant = Object.values(catalog.variants).find(
        (v) => v.pluCode != null && normalizePlu(v.pluCode) === match.pluCode,
      );
      if (!variant) throw new CartError("UNKNOWN_VARIANT", `no variant for PLU ${match.pluCode}`);
      assertNewLine(cart, action.lineId);
      assertMoney(variant.price);
      const base: CartLine = {
        lineId: action.lineId,
        variantId: variant.variantId,
        qtyMilli: 0,
        unitPrice: variant.price,
        discounts: [],
        scaleBarcode: action.barcode.trim(),
      };
      let line: CartLine;
      if (match.kind === "WEIGHT") {
        if (!isValidQty(match.qtyMilli, variant.unit)) throw new CartError("INVALID_QUANTITY");
        line = { ...base, qtyMilli: match.qtyMilli };
      } else if (!isFractionalUnit(variant.unit)) {
        line = { ...base, qtyMilli: 1000, labelTotal: match.price };
      } else {
        if (variant.price <= 0n) throw new CartError("INVALID_PRICE");
        // qty implied by the label price: price ÷ unit price, in thousandths.
        const qtyMilli = Number((match.price * 1000n + variant.price / 2n) / variant.price);
        if (!isValidQty(qtyMilli, variant.unit)) throw new CartError("INVALID_QUANTITY");
        line = { ...base, qtyMilli, labelTotal: match.price };
      }
      return { ...cart, lines: [...cart.lines, line] };
    }
    case "SET_QTY": {
      const line = findLine(cart, action.lineId);
      const variant = variantOf(catalog, line.variantId);
      if (!isValidQty(action.qtyMilli, variant.unit)) throw new CartError("INVALID_QUANTITY");
      return replaceLine(cart, action.lineId, (l) => {
        const { labelTotal: _drop, ...rest } = l;
        return { ...rest, qtyMilli: action.qtyMilli };
      });
    }
    case "REMOVE_LINE":
      findLine(cart, action.lineId);
      return { ...cart, lines: cart.lines.filter((l) => l.lineId !== action.lineId) };
    case "VOID_LINE":
      return replaceLine(cart, action.lineId, (l) => ({ ...l, voided: true }));
    case "SET_PRICE_OVERRIDE": {
      if (action.price !== null) assertMoney(action.price);
      return replaceLine(cart, action.lineId, (l) => {
        const { priceOverride: _drop, ...rest } = l;
        return action.price === null ? rest : { ...rest, priceOverride: action.price };
      });
    }
    case "ADD_LINE_DISCOUNT": {
      assertDiscount(action.discount);
      return replaceLine(cart, action.lineId, (l) => {
        if (l.discounts.length >= MAX_LINE_DISCOUNTS) throw new CartError("INVALID_DISCOUNT");
        return { ...l, discounts: [...l.discounts, action.discount] };
      });
    }
    case "CLEAR_LINE_DISCOUNTS":
      return replaceLine(cart, action.lineId, (l) => ({ ...l, discounts: [] }));
    case "SET_NOTE": {
      if (action.note !== null && action.note.length > MAX_NOTE_LENGTH) {
        throw new CartError("NOTE_TOO_LONG");
      }
      return replaceLine(cart, action.lineId, (l) => {
        const { note: _drop, ...rest } = l;
        return action.note ? { ...rest, note: action.note } : rest;
      });
    }
    case "APPLY_CART_DISCOUNT":
      assertDiscount(action.discount);
      if (cart.discounts.length >= MAX_CART_DISCOUNTS) throw new CartError("INVALID_DISCOUNT");
      return { ...cart, discounts: [...cart.discounts, action.discount] };
    case "CLEAR_CART_DISCOUNTS":
      return { ...cart, discounts: [] };
    case "CLEAR":
      return EMPTY_CART;
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface LineTotals {
  lineId: string;
  variantId: string;
  voided: boolean;
  qtyMilli: number;
  /** Price per unit actually charged (override ?? listed). */
  unitPrice: Money;
  /** Before any discount, in the line's pricing mode. */
  subtotal: Money;
  lineDiscount: Money;
  /** This line's pro-rata share of the cart discounts. */
  cartDiscount: Money;
  /** lineDiscount + cartDiscount. */
  discount: Money;
  net: Money;
  vat: Money;
  city: Money;
  gross: Money;
}

export interface SaleTotals {
  lines: LineTotals[];
  /** Σ line subtotals (line pricing mode; = Σ gross + discounts when prices include tax). */
  subtotal: Money;
  discountTotal: Money;
  netTotal: Money;
  vatTotal: Money;
  cityTotal: Money;
  /** vatTotal + cityTotal. */
  taxTotal: Money;
  /** Σ line gross, before rounding. */
  total: Money;
  /** Signed: payable − total. */
  roundingAmount: Money;
  /** total + roundingAmount: what the customer owes. */
  payable: Money;
}

interface Evaluated {
  totals: SaleTotals;
  lineStepBases: Map<string, ReturnType<typeof applyDiscountsSequentially>["steps"]>;
  cartSteps: ReturnType<typeof applyCartDiscounts>["steps"];
}

function lineBase(line: CartLine): { unitPrice: Money; base: Money } {
  const unitPrice = line.priceOverride ?? line.unitPrice;
  if (line.priceOverride === undefined && line.labelTotal !== undefined) {
    return { unitPrice, base: line.labelTotal };
  }
  return { unitPrice, base: extend(unitPrice, line.qtyMilli) };
}

function evaluate(cart: Cart, catalog: CatalogSnapshot, settings: CartSettings): Evaluated {
  const active = cart.lines.filter((l) => !l.voided);
  const bases = new Map<string, { unitPrice: Money; base: Money }>();
  const stepsByLine: Evaluated["lineStepBases"] = new Map();
  const afterLine = new Map<string, ReturnType<typeof applyDiscountsSequentially>>();

  for (const line of active) {
    variantOf(catalog, line.variantId); // fail fast on unknown variants
    if (
      !Number.isSafeInteger(line.qtyMilli) ||
      line.qtyMilli <= 0 ||
      line.qtyMilli > MAX_QTY_MILLI
    ) {
      throw new CartError("INVALID_QUANTITY");
    }
    const b = lineBase(line);
    bases.set(line.lineId, b);
    const applied = applyDiscountsSequentially(b.base, line.discounts);
    afterLine.set(line.lineId, applied);
    stepsByLine.set(line.lineId, applied.steps);
  }

  const cartResult = applyCartDiscounts(
    active.map((l) => afterLine.get(l.lineId)!.remaining),
    cart.discounts,
  );
  const cartShare = new Map(active.map((l, i) => [l.lineId, cartResult.perLine[i] ?? 0n]));

  const lines: LineTotals[] = cart.lines.map((line) => {
    if (line.voided) {
      return {
        lineId: line.lineId,
        variantId: line.variantId,
        voided: true,
        qtyMilli: line.qtyMilli,
        unitPrice: line.priceOverride ?? line.unitPrice,
        subtotal: 0n,
        lineDiscount: 0n,
        cartDiscount: 0n,
        discount: 0n,
        net: 0n,
        vat: 0n,
        city: 0n,
        gross: 0n,
      };
    }
    const variant = variantOf(catalog, line.variantId);
    const { unitPrice, base } = bases.get(line.lineId)!;
    const lineDiscount = afterLine.get(line.lineId)!.total;
    const cartDiscount = cartShare.get(line.lineId) ?? 0n;
    const remaining = base - lineDiscount - cartDiscount;
    // Tax terms come from the catalog (authoritative), not from the cart line.
    const tax = computeLineTax(remaining, {
      treatment: variant.taxTreatment,
      vatRateBps: variant.vatRateBps,
      cityTaxRateBps: variant.cityTaxRateBps,
      pricesIncludeTax: variant.pricesIncludeTax,
    });
    return {
      lineId: line.lineId,
      variantId: line.variantId,
      voided: false,
      qtyMilli: line.qtyMilli,
      unitPrice,
      subtotal: base,
      lineDiscount,
      cartDiscount,
      discount: lineDiscount + cartDiscount,
      net: tax.net,
      vat: tax.vat,
      city: tax.cityTax,
      gross: tax.gross,
    };
  });

  const total = sum(lines.map((l) => l.gross));
  const rounded = roundTotal(total, settings.totalRoundingUnit ?? DEFAULT_ROUNDING_UNIT);
  const vatTotal = sum(lines.map((l) => l.vat));
  const cityTotal = sum(lines.map((l) => l.city));
  return {
    totals: {
      lines,
      subtotal: sum(lines.map((l) => l.subtotal)),
      discountTotal: sum(lines.map((l) => l.discount)),
      netTotal: sum(lines.map((l) => l.net)),
      vatTotal,
      cityTotal,
      taxTotal: vatTotal + cityTotal,
      total,
      roundingAmount: rounded.roundingAmount,
      payable: rounded.payable,
    },
    lineStepBases: stepsByLine,
    cartSteps: cartResult.steps,
  };
}

/**
 * Deterministic totals for a cart. The server calls this with the catalog
 * loaded from the DB; the client with its snapshot. Throws `CartError` for a
 * variant missing from the catalog or an invalid quantity.
 */
export function computeTotals(
  cart: Cart,
  catalog: CatalogSnapshot,
  settings: CartSettings = {},
): SaleTotals {
  return evaluate(cart, catalog, settings).totals;
}

/**
 * Which manager approvals this cart needs: every price override (listed price
 * ≠ requested) and every discount whose effective rate exceeds the policy
 * threshold. Voided lines need none.
 */
export function requiredApprovals(
  cart: Cart,
  catalog: CatalogSnapshot,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
  settings: CartSettings = {},
): ApprovalRequirement[] {
  const { lineStepBases, cartSteps } = evaluate(cart, catalog, settings);
  const out: ApprovalRequirement[] = [];
  for (const line of cart.lines) {
    if (line.voided) continue;
    if (line.priceOverride !== undefined && line.priceOverride !== line.unitPrice) {
      out.push({
        key: approvalKeys.linePrice(line.lineId),
        kind: "PRICE_OVERRIDE",
        permission: "pos.price_override",
        scope: "LINE",
        lineId: line.lineId,
      });
    }
    (lineStepBases.get(line.lineId) ?? []).forEach((step, i) => {
      if (discountNeedsApproval(step.request, step.base, policy)) {
        out.push({
          key: approvalKeys.lineDiscount(line.lineId, i),
          kind: "DISCOUNT",
          permission: "pos.discount.manual",
          scope: "LINE",
          lineId: line.lineId,
        });
      }
    });
  }
  cartSteps.forEach((step, i) => {
    if (discountNeedsApproval(step.request, step.base, policy)) {
      out.push({
        key: approvalKeys.cartDiscount(i),
        kind: "DISCOUNT",
        permission: "pos.discount.manual",
        scope: "CART",
      });
    }
  });
  return out;
}
