/**
 * Discounts: line and cart discounts of the schema's kinds
 * (`DiscountKind`: PERCENT in bps, FIXED in möngö).
 *
 * Amounts are expressed in the line's pricing mode (tax-inclusive lines
 * discount the gross, tax-exclusive lines the net), matching
 * `SaleLine.discountAmount` ("same tax mode"). Tax is computed afterwards on
 * what is left.
 *
 * STACKING ORDER (fixed, documented in docs/checkout-domain.md):
 *   1. each line's own discounts, in array order, each applied to the amount
 *      remaining after the previous one (10% then 5% = 14.5%, not 15%);
 *   2. then the cart discounts, in array order, each resolved against the
 *      pool left across all lines and allocated pro-rata to the lines'
 *      remaining amounts by largest remainder (exact sum);
 *   3. tax per line on the remainder.
 * A discount can never take more than what remains, so lines never go
 * negative.
 */
import { BPS_DENOMINATOR, allocate, min, percentOf, sum, type Money } from "./money";

export const DISCOUNT_KINDS = ["PERCENT", "FIXED"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export type DiscountRequest =
  | { kind: "PERCENT"; percentBps: number; reason?: string }
  | { kind: "FIXED"; amount: Money; reason?: string };

export function isValidDiscountRequest(request: DiscountRequest): boolean {
  if (request.kind === "PERCENT") {
    return (
      Number.isInteger(request.percentBps) &&
      request.percentBps >= 1 &&
      request.percentBps <= 10_000
    );
  }
  return typeof request.amount === "bigint" && request.amount > 0n;
}

/** Amount a discount takes off `base`; always within `0..base`. */
export function resolveDiscount(base: Money, request: DiscountRequest): Money {
  if (base < 0n) throw new RangeError("resolveDiscount: base must not be negative");
  if (!isValidDiscountRequest(request)) throw new RangeError("resolveDiscount: invalid discount");
  const raw = request.kind === "PERCENT" ? percentOf(base, request.percentBps) : request.amount;
  return min(raw, base);
}

export interface DiscountStep {
  request: DiscountRequest;
  /** Amount remaining just before this discount was applied. */
  base: Money;
  /** Amount taken off. */
  amount: Money;
}

/** Apply discounts sequentially to one amount (line stacking). */
export function applyDiscountsSequentially(
  base: Money,
  requests: readonly DiscountRequest[],
): { steps: DiscountStep[]; total: Money; remaining: Money } {
  let remaining = base;
  const steps: DiscountStep[] = [];
  for (const request of requests) {
    const amount = resolveDiscount(remaining, request);
    steps.push({ request, base: remaining, amount });
    remaining -= amount;
  }
  return { steps, total: base - remaining, remaining };
}

/**
 * Spread a cart discount over lines pro-rata to their remaining amounts, by
 * largest remainder: the allocations sum EXACTLY to `amount` (capped at the
 * pool) and no line receives more than it has left.
 */
export function allocateCartDiscount(amount: Money, lineAmounts: readonly Money[]): Money[] {
  if (amount < 0n) throw new RangeError("allocateCartDiscount: amount must not be negative");
  const pool = sum(lineAmounts);
  return allocate(min(amount, pool), lineAmounts);
}

export interface CartDiscountResult {
  steps: DiscountStep[];
  /** Per-line total share of all cart discounts. */
  perLine: Money[];
  total: Money;
}

/** Apply cart discounts in order over the lines' remaining amounts. */
export function applyCartDiscounts(
  lineAmounts: readonly Money[],
  requests: readonly DiscountRequest[],
): CartDiscountResult {
  let remaining = [...lineAmounts];
  const perLine = lineAmounts.map(() => 0n);
  const steps: DiscountStep[] = [];
  for (const request of requests) {
    const pool = sum(remaining);
    const amount = resolveDiscount(pool, request);
    steps.push({ request, base: pool, amount });
    const shares = allocateCartDiscount(amount, remaining);
    remaining = remaining.map((r, i) => r - (shares[i] ?? 0n));
    shares.forEach((share, i) => (perLine[i] = (perLine[i] ?? 0n) + share));
  }
  return { steps, perLine, total: sum(perLine) };
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

export interface ApprovalPolicy {
  /**
   * A manual discount whose effective rate is ABOVE this needs manager
   * approval (bps). Default 1000 = 10%. Any price override always needs
   * approval, regardless of this value.
   */
  maxDiscountBpsWithoutApproval: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { maxDiscountBpsWithoutApproval: 1000 };

/** Does this discount, applied to `base`, exceed the unapproved threshold? */
export function discountNeedsApproval(
  request: DiscountRequest,
  base: Money,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): boolean {
  const threshold = BigInt(policy.maxDiscountBpsWithoutApproval);
  if (request.kind === "PERCENT") return BigInt(request.percentBps) > threshold;
  if (base <= 0n) return false;
  // amount / base > threshold / 10 000, in integers
  return resolveDiscount(base, request) * BPS_DENOMINATOR > threshold * base;
}

export type ApprovalKind = "PRICE_OVERRIDE" | "DISCOUNT";

export interface ApprovalRequirement {
  /**
   * Stable key into CheckoutInput.approvals:
   * `line:<lineId>:price`, `line:<lineId>:discount:<i>`, `cart:discount:<i>`.
   */
  key: string;
  kind: ApprovalKind;
  /** Permission the approving manager must hold (see permissions.ts). */
  permission: "pos.price_override" | "pos.discount.manual";
  scope: "LINE" | "CART";
  lineId?: string;
}

export const approvalKeys = {
  linePrice: (lineId: string) => `line:${lineId}:price`,
  lineDiscount: (lineId: string, index: number) => `line:${lineId}:discount:${index}`,
  cartDiscount: (index: number) => `cart:discount:${index}`,
} as const;
