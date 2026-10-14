/**
 * Register state: the pure cart (src/domain/cart.ts) plus what the UI needs
 * around it — the sale id, the catalog entries behind the lines and the
 * manager-approval tokens. Every cart mutation goes through the domain's
 * `reduceCart`; this module only adds bookkeeping, so the browser and the
 * server compute the same totals.
 */
import {
  EMPTY_CART,
  computeTotals,
  reduceCart,
  requiredApprovals,
  type Cart,
  type CartAction,
  type CartSettings,
} from "@/domain/cart";
import { DEFAULT_APPROVAL_POLICY, type ApprovalRequirement } from "@/domain/discounts";
import { hasPermission, type Role } from "@/domain/permissions";
import type { ScaleBarcodeRule } from "@/domain/scale-barcode";
import { indexEntries, snapshotOf, type CatalogEntry } from "./catalog-entry";

/** The server's approval tokens live 5 minutes; stop trusting ours a bit earlier. */
export const APPROVAL_CLIENT_TTL_MS = 4 * 60 * 1000;

export interface ApprovalGrant {
  token: string;
  /** What was approved (price or discount value); a change invalidates the grant. */
  fingerprint: string;
  approverName: string;
  grantedAt: number;
}

export interface PosState {
  /** UUIDv7 of the sale being rung up; sent as the idempotency key. */
  saleId: string;
  cart: Cart;
  approvals: Record<string, ApprovalGrant>;
  entries: Record<string, CatalogEntry>;
}

export type MutatingCartAction = Exclude<CartAction, { type: "ADD_ITEM" } | { type: "ADD_SCALE" }>;

export type PosAction =
  | { type: "add"; entry: CatalogEntry; qtyMilli: number; lineId: string; merge?: boolean }
  | { type: "addScale"; entry: CatalogEntry; barcode: string; lineId: string }
  | { type: "cart"; action: MutatingCartAction }
  /** Learn about catalog entries without touching the cart. */
  | { type: "entries"; entries: readonly CatalogEntry[] }
  /** Take the current catalog prices for the lines (after STALE_PRICE). */
  | { type: "reprice"; entries: readonly CatalogEntry[] }
  | { type: "approve"; grants: Record<string, ApprovalGrant> }
  | { type: "dropApprovals" }
  | { type: "reset"; saleId: string }
  | { type: "load"; state: PosState };

export interface PosConfig {
  rules?: readonly ScaleBarcodeRule[];
  totalRoundingUnit: bigint;
}

export function initialPosState(saleId: string): PosState {
  return { saleId, cart: EMPTY_CART, approvals: {}, entries: {} };
}

export function cartSettings(config: Pick<PosConfig, "totalRoundingUnit">): CartSettings {
  return { totalRoundingUnit: config.totalRoundingUnit };
}

/** What a requirement is about, for detecting that the approved thing changed. */
export function approvalFingerprint(requirement: ApprovalRequirement): string {
  return requirement.value;
}

function safeRequirements(state: PosState, config: PosConfig): ApprovalRequirement[] {
  try {
    return requiredApprovals(
      state.cart,
      snapshotOf(state.entries),
      DEFAULT_APPROVAL_POLICY,
      cartSettings(config),
    );
  } catch {
    return [];
  }
}

/** Keep only the grants that still match a requirement of the current cart. */
function pruneApprovals(state: PosState, config: PosConfig): PosState {
  if (Object.keys(state.approvals).length === 0) return state;
  const requirements = new Map(safeRequirements(state, config).map((r) => [r.key, r]));
  const kept: Record<string, ApprovalGrant> = {};
  for (const [key, grant] of Object.entries(state.approvals)) {
    const requirement = requirements.get(key);
    if (requirement && approvalFingerprint(requirement) === grant.fingerprint) {
      kept[key] = grant;
    }
  }
  return Object.keys(kept).length === Object.keys(state.approvals).length
    ? state
    : { ...state, approvals: kept };
}

export function createPosReducer(config: PosConfig) {
  const withCart = (state: PosState, cart: Cart): PosState =>
    cart === state.cart ? state : pruneApprovals({ ...state, cart }, config);

  return function posReducer(state: PosState, action: PosAction): PosState {
    switch (action.type) {
      case "entries":
        return { ...state, entries: { ...state.entries, ...indexEntries(action.entries) } };
      case "add": {
        const entries = { ...state.entries, [action.entry.variantId]: action.entry };
        const result = reduceCart(
          state.cart,
          {
            type: "ADD_ITEM",
            lineId: action.lineId,
            variantId: action.entry.variantId,
            qtyMilli: action.qtyMilli,
            ...(action.merge === false ? { merge: false } : {}),
          },
          snapshotOf(entries),
        );
        return result.ok ? withCart({ ...state, entries }, result.cart) : state;
      }
      case "addScale": {
        const entries = { ...state.entries, [action.entry.variantId]: action.entry };
        const result = reduceCart(
          state.cart,
          {
            type: "ADD_SCALE",
            lineId: action.lineId,
            barcode: action.barcode,
            ...(config.rules ? { rules: config.rules } : {}),
          },
          snapshotOf(entries),
        );
        return result.ok ? withCart({ ...state, entries }, result.cart) : state;
      }
      case "cart": {
        const result = reduceCart(state.cart, action.action, snapshotOf(state.entries));
        if (!result.ok) return state;
        // Clearing the cart starts over; the sale id stays (nothing was sold).
        return withCart(state, result.cart);
      }
      case "reprice": {
        const entries = { ...state.entries, ...indexEntries(action.entries) };
        const lines = state.cart.lines.map((line) => {
          const entry = entries[line.variantId];
          return entry && entry.price !== line.unitPrice
            ? { ...line, unitPrice: entry.price }
            : line;
        });
        const cart = { ...state.cart, lines };
        return pruneApprovals({ ...state, entries, cart }, config);
      }
      case "approve":
        return { ...state, approvals: { ...state.approvals, ...action.grants } };
      case "dropApprovals":
        return Object.keys(state.approvals).length === 0 ? state : { ...state, approvals: {} };
      // The catalog entries are what the grid and search know about, not part of
      // a sale: a new sale or a resumed cart keeps them.
      case "reset":
        return { ...initialPosState(action.saleId), entries: state.entries };
      case "load":
        return { ...action.state, entries: { ...state.entries, ...action.state.entries } };
    }
  };
}

// --- Derived values ----------------------------------------------------------

export function totalsOf(state: PosState, config: PosConfig) {
  return computeTotals(state.cart, snapshotOf(state.entries), cartSettings(config));
}

/** Requirements the signed-in user cannot satisfy themselves and nobody has approved yet. */
export function pendingApprovals(
  state: PosState,
  config: PosConfig,
  role: Role,
  now: number,
): ApprovalRequirement[] {
  return safeRequirements(state, config).filter((requirement) => {
    if (hasPermission(role, requirement.permission)) return false;
    const grant = state.approvals[requirement.key];
    return !(
      grant &&
      grant.fingerprint === approvalFingerprint(requirement) &&
      now - grant.grantedAt < APPROVAL_CLIENT_TTL_MS
    );
  });
}

export function activeLineCount(cart: Cart): number {
  return cart.lines.filter((l) => !l.voided).length;
}

export function isCartEmpty(cart: Cart): boolean {
  return activeLineCount(cart) === 0;
}

/** Approval tokens to send with the checkout: only those the cart still needs. */
export function approvalTokens(state: PosState, config: PosConfig): Record<string, string> {
  const needed = new Set(safeRequirements(state, config).map((r) => r.key));
  const out: Record<string, string> = {};
  for (const [key, grant] of Object.entries(state.approvals)) {
    if (needed.has(key)) out[key] = grant.token;
  }
  return out;
}
