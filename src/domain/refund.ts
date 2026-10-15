/**
 * Refund / return / exchange math (Phase 3, pure). Money is bigint möngö,
 * quantities are `qtyMilli` ints. No I/O, no clock (the caller passes `now`).
 *
 * Exactness. A line's FINAL gross (`totalAmount` = net + vat + city, after every
 * line and cart discount) is refunded by the CUMULATIVE rule:
 *
 *     F(c) = round_half_up(total × c / lineQty)        c = cumulative refunded qty
 *     this refund's gross = F(c_before + q) − (amount already refunded)
 *
 * and the step that takes the line to zero remaining quantity refunds exactly
 * what is left (the "last unit" rule). Because the amounts telescope, refunding
 * a line in any number of pieces, in any order, sums EXACTLY to the original
 * line total: no 1-möngö drift. The same rule runs independently on VAT and
 * city tax; net is the difference, so net + vat + city = gross at every step
 * and every part stays within what is left of the original line.
 *
 * Over-refund is impossible by construction: every step is clamped to the
 * remaining quantity and the remaining amount of each part, and payments are
 * clamped to what each original tender has left.
 */
import { divRound, min, roundToUnit, sum, allocate, type Money } from "./money";
import { MAX_QTY_MILLI, extend, isValidQty, type Unit } from "./qty";

// ---------------------------------------------------------------------------
// Snapshots (plain rows loaded by the service)
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "QPAY",
  "BANK_TRANSFER",
  "GIFT_CARD",
  "STORE_CREDIT",
  "EXCHANGE_CREDIT",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods a refund can be paid out through today. */
export const REFUNDABLE_METHODS = ["CASH", "CARD", "QPAY", "BANK_TRANSFER"] as const;
/** Phase 4 stubs: refunding to these returns a NOT_SUPPORTED issue. */
export const UNSUPPORTED_REFUND_METHODS = ["GIFT_CARD", "STORE_CREDIT", "EXCHANGE_CREDIT"] as const;
/** With manager approval a refund may be paid in these regardless of the original tender. */
export const CROSS_METHOD_TARGETS = ["CASH", "BANK_TRANSFER"] as const;

export const RETURN_REASONS = [
  "DEFECTIVE",
  "DAMAGED",
  "WRONG_ITEM",
  "NOT_AS_DESCRIBED",
  "CHANGED_MIND",
  "OTHER",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const MAX_REFUND_LINES = 200;

export interface RefundSaleLine {
  id: string;
  variantId: string;
  unit: Unit;
  qtyMilli: number;
  /** FINAL gross after all discounts = netAmount + vatAmount + cityTaxAmount. */
  totalAmount: Money;
  netAmount: Money;
  vatAmount: Money;
  cityTaxAmount: Money;
  /** COGS snapshot per whole unit. */
  unitCost: Money;
  /** False for services / non-stocked items: nothing to put back. Default true. */
  tracksStock?: boolean;
  /** Phase 4: a sold gift card cannot be refunded here. */
  isGiftCard?: boolean;
  /** Informational tax mode of the original line. */
  pricesIncludeTax?: boolean;
}

export interface RefundSalePayment {
  id: string;
  method: PaymentMethod;
  /** Applied to the sale, EXCLUDING change: for cash this is what the till kept. */
  amount: Money;
  change?: Money;
}

export interface RefundSaleSnapshot {
  id: string;
  status: "COMPLETED" | "VOIDED";
  occurredAt: Date;
  shiftId: string;
  totalAmount: Money;
  tipAmount: Money;
  roundingAmount: Money;
  lines: RefundSaleLine[];
  /** In payment order (oldest first). */
  payments: RefundSalePayment[];
}

export interface PreviousRefund {
  id: string;
  totalAmount: Money;
  tipAmount: Money;
  lines: {
    saleLineId: string;
    qtyMilli: number;
    netAmount: Money;
    vatAmount: Money;
    cityTaxAmount: Money;
    totalAmount: Money;
  }[];
  /** `originalPaymentId` is the sale payment whose value this row consumed. */
  payments: { method: PaymentMethod; amount: Money; originalPaymentId: string | null }[];
}

// ---------------------------------------------------------------------------
// Per-line progress and the exact share rule
// ---------------------------------------------------------------------------

export interface MoneyParts {
  net: Money;
  vat: Money;
  city: Money;
  total: Money;
}

export interface LineProgress {
  saleLineId: string;
  unit: Unit;
  qtyMilli: number;
  refundedQtyMilli: number;
  remainingQtyMilli: number;
  refunded: MoneyParts;
  remaining: MoneyParts;
}

function assertSaleLine(line: RefundSaleLine): void {
  if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0) {
    throw new RangeError(`refund: line ${line.id} has an invalid quantity`);
  }
  if (line.netAmount + line.vatAmount + line.cityTaxAmount !== line.totalAmount) {
    throw new RangeError(`refund: line ${line.id} net + vat + city !== total`);
  }
  if (line.netAmount < 0n || line.vatAmount < 0n || line.cityTaxAmount < 0n) {
    throw new RangeError(`refund: line ${line.id} has a negative part`);
  }
}

/** Refunded and remaining quantity/amounts per sale line, from the stored refunds. */
export function lineProgress(
  sale: Pick<RefundSaleSnapshot, "lines">,
  previousRefunds: readonly PreviousRefund[],
): LineProgress[] {
  return sale.lines.map((line) => {
    assertSaleLine(line);
    let qty = 0;
    const done: MoneyParts = { net: 0n, vat: 0n, city: 0n, total: 0n };
    for (const refund of previousRefunds) {
      for (const rl of refund.lines) {
        if (rl.saleLineId !== line.id) continue;
        qty += rl.qtyMilli;
        done.net += rl.netAmount;
        done.vat += rl.vatAmount;
        done.city += rl.cityTaxAmount;
        done.total += rl.totalAmount;
      }
    }
    if (
      qty > line.qtyMilli ||
      done.net > line.netAmount ||
      done.vat > line.vatAmount ||
      done.city > line.cityTaxAmount ||
      done.total > line.totalAmount
    ) {
      throw new RangeError(`refund: previous refunds exceed line ${line.id}`);
    }
    return {
      saleLineId: line.id,
      unit: line.unit,
      qtyMilli: line.qtyMilli,
      refundedQtyMilli: qty,
      remainingQtyMilli: line.qtyMilli - qty,
      refunded: done,
      remaining: {
        net: line.netAmount - done.net,
        vat: line.vatAmount - done.vat,
        city: line.cityTaxAmount - done.city,
        total: line.totalAmount - done.total,
      },
    };
  });
}

const clamp = (value: Money, low: Money, high: Money): Money =>
  value < low ? low : value > high ? high : value;

/**
 * The exact share of `line` for refunding `qtyMilli` more units, given the
 * progress so far. `qtyMilli` must be in 1..progress.remainingQtyMilli.
 */
export function refundShare(
  line: RefundSaleLine,
  progress: LineProgress,
  qtyMilli: number,
): MoneyParts {
  if (
    !Number.isSafeInteger(qtyMilli) ||
    qtyMilli <= 0 ||
    qtyMilli > progress.remainingQtyMilli ||
    progress.saleLineId !== line.id
  ) {
    throw new RangeError("refundShare: quantity out of range");
  }
  const rem = progress.remaining;
  if (qtyMilli === progress.remainingQtyMilli) return { ...rem }; // last unit: exactly what is left

  const cumulative = BigInt(progress.refundedQtyMilli + qtyMilli);
  const lineQty = BigInt(line.qtyMilli);
  const target = (amount: Money): Money => divRound(amount * cumulative, lineQty);

  const gross = clamp(target(line.totalAmount) - progress.refunded.total, 0n, rem.total);
  const vat = clamp(target(line.vatAmount) - progress.refunded.vat, 0n, min(rem.vat, gross));
  const city = clamp(
    target(line.cityTaxAmount) - progress.refunded.city,
    0n,
    min(rem.city, gross - vat),
  );
  let net = gross - vat - city;
  let vatOut = vat;
  let cityOut = city;
  if (net > rem.net) {
    // Net ran out first: push the excess into tax parts that still have room.
    let excess = net - rem.net;
    net = rem.net;
    const addVat = min(excess, rem.vat - vatOut);
    vatOut += addVat;
    excess -= addVat;
    const addCity = min(excess, rem.city - cityOut);
    cityOut += addCity;
    excess -= addCity;
    if (excess !== 0n) throw new RangeError("refundShare: cannot place the refunded amount");
  }
  return { net, vat: vatOut, city: cityOut, total: gross };
}

// ---------------------------------------------------------------------------
// Payment capacity and allocation
// ---------------------------------------------------------------------------

export interface PaymentCapacity {
  id: string;
  method: PaymentMethod;
  paid: Money;
  refunded: Money;
  /** paid − refunded: what can still be given back through this tender. */
  remaining: Money;
}

export function paymentCapacities(
  sale: Pick<RefundSaleSnapshot, "payments">,
  previousRefunds: readonly PreviousRefund[],
): PaymentCapacity[] {
  return sale.payments.map((payment) => {
    let refunded = 0n;
    for (const refund of previousRefunds) {
      for (const rp of refund.payments) {
        if (rp.originalPaymentId === payment.id) refunded += rp.amount;
      }
    }
    if (payment.amount < 0n || refunded > payment.amount) {
      throw new RangeError(`refund: payment ${payment.id} refunded more than paid`);
    }
    return {
      id: payment.id,
      method: payment.method,
      paid: payment.amount,
      refunded,
      remaining: payment.amount - refunded,
    };
  });
}

export type AllocationStrategy = "PROPORTIONAL" | "LIFO";

export interface Source {
  id: string;
  method: PaymentMethod;
  cap: Money;
}

const floorTo = (value: Money, unit: Money): Money => value - (value % unit);

/**
 * Spread `amount` over `sources` without exceeding any cap; CASH parts are
 * whole multiples of `cashUnit`. Returns null when it cannot be done.
 * Sums exactly to `amount`.
 */
export function allocateAcrossSources(
  amount: Money,
  sources: readonly Source[],
  strategy: AllocationStrategy,
  cashUnit: Money,
): Money[] | null {
  if (amount < 0n || cashUnit <= 0n) throw new RangeError("allocateAcrossSources: bad input");
  const eff = sources.map((s) => (s.method === "CASH" ? floorTo(s.cap, cashUnit) : s.cap));
  if (sum(eff) < amount) return null;
  const parts = sources.map(() => 0n);
  if (amount === 0n) return parts;

  if (strategy === "LIFO") {
    let left = amount;
    for (let i = sources.length - 1; i >= 0 && left > 0n; i--) {
      let take = min(left, eff[i]!);
      if (sources[i]!.method === "CASH") take = floorTo(take, cashUnit);
      parts[i] = take;
      left -= take;
    }
    return left === 0n ? parts : null;
  }

  const shares = allocate(amount, eff);
  let leftover = 0n;
  sources.forEach((s, i) => {
    let part = shares[i]!;
    if (s.method === "CASH") {
      const excess = part % cashUnit;
      part -= excess;
      leftover += excess;
    }
    parts[i] = part;
  });
  for (const cash of [false, true]) {
    sources.forEach((s, i) => {
      if ((s.method === "CASH") !== cash || leftover === 0n) return;
      let give = min(leftover, eff[i]! - parts[i]!);
      if (cash) give = floorTo(give, cashUnit);
      parts[i] = parts[i]! + give;
      leftover -= give;
    });
  }
  return leftover === 0n ? parts : null;
}

export interface PlannedRefundPayment {
  method: PaymentMethod;
  amount: Money;
  /** The original sale payment whose value this row consumes. */
  originalPaymentId: string;
  /** Paid out in a different method than the tender it consumed (needs approval). */
  crossMethod: boolean;
}

// ---------------------------------------------------------------------------
// Request, context and result
// ---------------------------------------------------------------------------

export interface RefundRequestLine {
  saleLineId: string;
  qtyMilli: number;
  restock: boolean;
  reason?: ReturnReason | undefined;
}

export interface PaymentOverrideEntry {
  method: PaymentMethod;
  amount: Money;
}

export interface RefundRequest {
  lines: RefundRequestLine[];
  reason: ReturnReason;
  note?: string | undefined;
  /** Manager override of the payout methods (covers the NET refund, after exchange credit). */
  paymentOverride?: PaymentOverrideEntry[] | undefined;
  /** Exchange: the payable of the replacement sale. */
  exchangeSaleTotal?: Money | undefined;
}

export interface RefundPolicy {
  /** Refunds older than this many whole days need approval. null/undefined = no limit. */
  maxRefundWindowDays?: number | null | undefined;
}

export interface RefundContext {
  /** The refund is booked against the current open shift. */
  shiftOpen: boolean;
  /** Pure: the caller supplies the clock. */
  now: Date;
  /** Totals round to this (BusinessSettings.totalRoundingUnit). */
  roundingUnit: Money;
  /** Smallest cash coin; default min(roundingUnit, 1₮). */
  cashUnit?: Money;
  policy?: RefundPolicy;
  /** Default PROPORTIONAL. */
  strategy?: AllocationStrategy;
  /** What the actor holds right now (own permission or a valid approval token). */
  grants: {
    /** `pos.refund` or a valid `pos.refund.approve` token for this refund. */
    refund: boolean;
    /** Approval to pay out through a method other than the original tender. */
    methodOverride: boolean;
    /** Approval to refund outside the window. */
    outsideWindow: boolean;
  };
}

export type RefundIssueCode =
  | "SHIFT_NOT_OPEN"
  | "SALE_NOT_COMPLETED"
  | "NO_LINES"
  | "TOO_MANY_LINES"
  | "DUPLICATE_LINE"
  | "UNKNOWN_LINE"
  | "INVALID_QUANTITY"
  | "ALREADY_REFUNDED"
  | "OVER_REFUND"
  | "REASON_NOTE_REQUIRED"
  | "NOT_SUPPORTED"
  | "REFUND_METHOD_NOT_ALLOWED"
  | "PAYMENT_MISMATCH"
  | "CASH_NOT_IN_UNITS"
  | "ALLOCATION_FAILED"
  | "REFUND_WINDOW_EXCEEDED"
  | "EXCHANGE_INVALID"
  | "APPROVAL_REQUIRED";

export interface RefundIssue {
  code: RefundIssueCode;
  saleLineId?: string;
  details?: Record<string, string | number | boolean | string[]>;
}

export interface PlannedRefundLine {
  saleLineId: string;
  variantId: string;
  qtyMilli: number;
  restock: boolean;
  reason?: ReturnReason | undefined;
  netAmount: Money;
  vatAmount: Money;
  cityTaxAmount: Money;
  totalAmount: Money;
  /** Snapshot COGS per unit of the ORIGINAL sale. */
  unitCost: Money;
  /** COGS put back: only for restocked lines, at the original snapshot. */
  cogsReversal: Money;
}

export interface PlannedStockRestore {
  saleLineId: string;
  variantId: string;
  qtyMilli: number;
  unitCost: Money;
}

export interface RefundApprovalNeeds {
  refund: boolean;
  methodOverride: boolean;
  outsideWindow: boolean;
}

export interface RefundPlan {
  lines: PlannedRefundLine[];
  /** Σ line totals (before tip and rounding). */
  itemsTotal: Money;
  netAmount: Money;
  vatAmount: Money;
  cityTaxAmount: Money;
  tipAmount: Money;
  /** Signed: totalAmount − itemsTotal − tipAmount. */
  roundingAmount: Money;
  /** What the customer is credited: items + tip + rounding. */
  totalAmount: Money;
  /** True when this refund leaves nothing refundable on the sale. */
  completesSale: boolean;
  exchange: null | {
    newSaleTotal: Money;
    /** Value carried into the new sale as EXCHANGE_CREDIT. */
    creditApplied: Money;
    /** Still to be paid for the new sale (tendered normally). */
    netDue: Money;
    /** Still to be paid back to the customer. */
    netRefund: Money;
  };
  /** Rows to write as RefundPayment (EXCHANGE_CREDIT rows carry the exchange credit). */
  payments: PlannedRefundPayment[];
  /** Σ CASH rows: what leaves the drawer. */
  cashRefund: Money;
  stockRestores: PlannedStockRestore[];
  cogsReversalTotal: Money;
  needs: RefundApprovalNeeds;
}

export type RefundPlanResult =
  { ok: true; plan: RefundPlan } | { ok: false; issues: RefundIssue[]; preview?: RefundPlan };

const DAY_MS = 86_400_000;

function isUnsupported(method: PaymentMethod): boolean {
  return (UNSUPPORTED_REFUND_METHODS as readonly string[]).includes(method);
}

/** Remaining refundable quantity and money per line (for the refund picker UI). */
export function refundableLines(
  sale: RefundSaleSnapshot,
  previousRefunds: readonly PreviousRefund[],
): LineProgress[] {
  return lineProgress(sale, previousRefunds);
}

/** Σ refunded + remaining reconcile: nothing left on any line. */
export function isFullyRefunded(
  sale: RefundSaleSnapshot,
  previousRefunds: readonly PreviousRefund[],
): boolean {
  return lineProgress(sale, previousRefunds).every((p) => p.remainingQtyMilli === 0);
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export function planRefund(
  sale: RefundSaleSnapshot,
  previousRefunds: readonly PreviousRefund[],
  request: RefundRequest,
  context: RefundContext,
): RefundPlanResult {
  const issues: RefundIssue[] = [];
  const unit = context.roundingUnit;
  if (unit <= 0n) throw new RangeError("planRefund: roundingUnit must be positive");
  const cashUnit = context.cashUnit ?? min(unit, 100n);

  if (!context.shiftOpen) issues.push({ code: "SHIFT_NOT_OPEN" });
  if (sale.status !== "COMPLETED") issues.push({ code: "SALE_NOT_COMPLETED" });
  if (request.reason === "OTHER" && !request.note?.trim()) {
    issues.push({ code: "REASON_NOTE_REQUIRED" });
  }

  // ---- lines --------------------------------------------------------------
  if (request.lines.length === 0) issues.push({ code: "NO_LINES" });
  if (request.lines.length > MAX_REFUND_LINES) issues.push({ code: "TOO_MANY_LINES" });
  const progress = lineProgress(sale, previousRefunds);
  const progressById = new Map(progress.map((p) => [p.saleLineId, p]));
  const lineById = new Map(sale.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const planned: PlannedRefundLine[] = [];

  for (const requested of request.lines.slice(0, MAX_REFUND_LINES)) {
    const id = requested.saleLineId;
    if (seen.has(id)) {
      issues.push({ code: "DUPLICATE_LINE", saleLineId: id });
      continue;
    }
    seen.add(id);
    const line = lineById.get(id);
    const prog = progressById.get(id);
    if (!line || !prog) {
      issues.push({ code: "UNKNOWN_LINE", saleLineId: id });
      continue;
    }
    if (line.isGiftCard) {
      issues.push({ code: "NOT_SUPPORTED", saleLineId: id, details: { what: "GIFT_CARD_LINE" } });
      continue;
    }
    if (prog.remainingQtyMilli === 0) {
      issues.push({ code: "ALREADY_REFUNDED", saleLineId: id });
      continue;
    }
    if (
      !Number.isSafeInteger(requested.qtyMilli) ||
      requested.qtyMilli > MAX_QTY_MILLI ||
      !isValidQty(requested.qtyMilli, line.unit)
    ) {
      issues.push({ code: "INVALID_QUANTITY", saleLineId: id });
      continue;
    }
    if (requested.qtyMilli > prog.remainingQtyMilli) {
      issues.push({
        code: "OVER_REFUND",
        saleLineId: id,
        details: {
          remainingQtyMilli: prog.remainingQtyMilli,
          requestedQtyMilli: requested.qtyMilli,
        },
      });
      continue;
    }
    const share = refundShare(line, prog, requested.qtyMilli);
    const restock = requested.restock && (line.tracksStock ?? true);
    planned.push({
      saleLineId: id,
      variantId: line.variantId,
      qtyMilli: requested.qtyMilli,
      restock,
      reason: requested.reason,
      netAmount: share.net,
      vatAmount: share.vat,
      cityTaxAmount: share.city,
      totalAmount: share.total,
      unitCost: line.unitCost,
      cogsReversal: restock ? extend(line.unitCost, requested.qtyMilli) : 0n,
    });
  }

  // ---- window -------------------------------------------------------------
  let outsideWindow = false;
  const windowDays = context.policy?.maxRefundWindowDays;
  if (windowDays !== null && windowDays !== undefined) {
    const age = Math.floor((context.now.getTime() - sale.occurredAt.getTime()) / DAY_MS);
    outsideWindow = age > windowDays;
  }

  // Money below needs a sane request; keep going only if the lines are usable.
  if (issues.length > 0 || planned.length === 0) {
    return { ok: false, issues };
  }

  // ---- totals -------------------------------------------------------------
  const itemsTotal = sum(planned.map((l) => l.totalAmount));
  const netAmount = sum(planned.map((l) => l.netAmount));
  const vatAmount = sum(planned.map((l) => l.vatAmount));
  const cityTaxAmount = sum(planned.map((l) => l.cityTaxAmount));

  const refundedPaid = sum(previousRefunds.map((r) => r.totalAmount));
  const refundedTip = sum(previousRefunds.map((r) => r.tipAmount));
  const remainingPaid = sale.totalAmount - refundedPaid;
  const requestedById = new Map(planned.map((l) => [l.saleLineId, l.qtyMilli]));
  const completesSale = progress.every(
    (p) => p.remainingQtyMilli - (requestedById.get(p.saleLineId) ?? 0) === 0,
  );

  let tipAmount = 0n;
  let totalAmount: Money;
  if (completesSale) {
    // The last refund returns everything still held, tip and rounding included
    // (rounding taken earlier is recovered here, so it can come out negative).
    totalAmount = remainingPaid;
    tipAmount = sale.tipAmount - refundedTip;
    if (tipAmount < 0n || totalAmount < 0n) {
      issues.push({ code: "OVER_REFUND", details: { remainingPaid: remainingPaid.toString() } });
      return { ok: false, issues };
    }
  } else {
    totalAmount = min(roundToUnit(itemsTotal, unit), remainingPaid);
    if (totalAmount < 0n) totalAmount = 0n;
  }
  const roundingAmount = totalAmount - itemsTotal - tipAmount;

  // ---- exchange -----------------------------------------------------------
  let exchange: RefundPlan["exchange"] = null;
  if (request.exchangeSaleTotal !== undefined) {
    const newTotal = request.exchangeSaleTotal;
    if (newTotal <= 0n) {
      issues.push({ code: "EXCHANGE_INVALID" });
      return { ok: false, issues };
    }
    const creditApplied = min(totalAmount, newTotal);
    exchange = {
      newSaleTotal: newTotal,
      creditApplied,
      netDue: newTotal - creditApplied,
      netRefund: totalAmount - creditApplied,
    };
  }
  const creditApplied = exchange?.creditApplied ?? 0n;
  const netRefund = totalAmount - creditApplied;

  // ---- payments -----------------------------------------------------------
  const capacities = paymentCapacities(sale, previousRefunds);
  const payments: PlannedRefundPayment[] = [];
  let crossMethodUsed = false;
  const caps = new Map(capacities.map((c) => [c.id, c.remaining]));
  const methodOf = new Map(capacities.map((c) => [c.id, c.method]));
  const order = capacities.map((c) => c.id);
  if (totalAmount > sum([...caps.values()])) {
    issues.push({
      code: "OVER_REFUND",
      details: { remainingPaid: sum([...caps.values()]).toString() },
    });
    return { ok: false, issues };
  }
  const take = (id: string, amount: Money): void => {
    caps.set(id, caps.get(id)! - amount);
  };

  if (netRefund > 0n) {
    if (request.paymentOverride && request.paymentOverride.length > 0) {
      const outcome = allocateOverride(
        netRefund,
        request.paymentOverride,
        order,
        caps,
        methodOf,
        cashUnit,
      );
      if (!outcome.ok) {
        issues.push(...outcome.issues);
        return { ok: false, issues };
      }
      for (const row of outcome.rows) {
        take(row.originalPaymentId, row.amount);
        payments.push(row);
        if (row.crossMethod) crossMethodUsed = true;
      }
    } else {
      const usable = order.filter((id) => !isUnsupported(methodOf.get(id)!) && caps.get(id)! > 0n);
      const parts = allocateAcrossSources(
        netRefund,
        usable.map((id) => ({ id, method: methodOf.get(id)!, cap: caps.get(id)! })),
        context.strategy ?? "PROPORTIONAL",
        cashUnit,
      );
      if (!parts) {
        const blocked = order.filter(
          (id) => isUnsupported(methodOf.get(id)!) && caps.get(id)! > 0n,
        );
        if (blocked.length > 0) {
          issues.push({
            code: "NOT_SUPPORTED",
            details: { methods: [...new Set(blocked.map((id) => methodOf.get(id)!))] },
          });
        } else {
          issues.push({ code: "ALLOCATION_FAILED" });
        }
        return { ok: false, issues };
      }
      usable.forEach((id, i) => {
        const amount = parts[i]!;
        if (amount === 0n) return;
        take(id, amount);
        payments.push({
          method: methodOf.get(id)!,
          amount,
          originalPaymentId: id,
          crossMethod: false,
        });
      });
    }
  }

  if (creditApplied > 0n) {
    // The exchange credit consumes whatever value is left, tenders that cannot
    // be paid back first (gift card, store credit), then newest first.
    const rest = order
      .filter((id) => caps.get(id)! > 0n)
      .sort((a, b) => {
        const ua = isUnsupported(methodOf.get(a)!) ? 0 : 1;
        const ub = isUnsupported(methodOf.get(b)!) ? 0 : 1;
        return ua !== ub ? ua - ub : order.indexOf(b) - order.indexOf(a);
      });
    let left = creditApplied;
    for (const id of rest) {
      if (left === 0n) break;
      const amount = min(left, caps.get(id)!);
      take(id, amount);
      left -= amount;
      payments.push({
        method: "EXCHANGE_CREDIT",
        amount,
        originalPaymentId: id,
        crossMethod: false,
      });
    }
    if (left !== 0n) {
      issues.push({ code: "ALLOCATION_FAILED" });
      return { ok: false, issues };
    }
  }

  const paymentSum = sum(payments.map((p) => p.amount));
  if (paymentSum !== totalAmount) {
    throw new RangeError("planRefund: payments do not add up to the refund total");
  }

  const stockRestores = planned
    .filter((l) => l.restock)
    .map((l) => ({
      saleLineId: l.saleLineId,
      variantId: l.variantId,
      qtyMilli: l.qtyMilli,
      unitCost: l.unitCost,
    }));

  const needs: RefundApprovalNeeds = {
    refund: true,
    methodOverride: crossMethodUsed,
    outsideWindow,
  };
  const plan: RefundPlan = {
    lines: planned,
    itemsTotal,
    netAmount,
    vatAmount,
    cityTaxAmount,
    tipAmount,
    roundingAmount,
    totalAmount,
    completesSale,
    exchange,
    payments,
    cashRefund: sum(payments.filter((p) => p.method === "CASH").map((p) => p.amount)),
    stockRestores,
    cogsReversalTotal: sum(planned.map((l) => l.cogsReversal)),
    needs,
  };

  const missing: string[] = [];
  if (!context.grants.refund) missing.push("refund");
  if (needs.methodOverride && !context.grants.methodOverride) missing.push("methodOverride");
  if (needs.outsideWindow && !context.grants.outsideWindow) {
    issues.push({ code: "REFUND_WINDOW_EXCEEDED", details: { maxDays: windowDays ?? 0 } });
    missing.push("outsideWindow");
  }
  if (missing.length > 0) {
    issues.push({ code: "APPROVAL_REQUIRED", details: { needs: missing } });
  }
  if (issues.length > 0) return { ok: false, issues, preview: plan };
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------
// Manager override of the payout methods
// ---------------------------------------------------------------------------

type OverrideOutcome =
  { ok: true; rows: PlannedRefundPayment[] } | { ok: false; issues: RefundIssue[] };

/**
 * Rules: Σ entries = the net refund; each entry is a positive amount in a
 * refundable method. Value comes from original tenders of the SAME method
 * first (newest first). Whatever an entry still needs is "cross-method": only
 * CASH and BANK_TRANSFER may do that, and the caller must hold the override
 * approval. CARD / QPAY can never be paid beyond what that method originally
 * paid, approval or not. Every row names the original payment it consumes, so
 * no tender can ever give back more than it took.
 */
function allocateOverride(
  netRefund: Money,
  entries: readonly PaymentOverrideEntry[],
  order: readonly string[],
  caps: Map<string, Money>,
  methodOf: Map<string, PaymentMethod>,
  cashUnit: Money,
): OverrideOutcome {
  const issues: RefundIssue[] = [];
  for (const entry of entries) {
    if (entry.amount <= 0n)
      issues.push({ code: "PAYMENT_MISMATCH", details: { method: entry.method } });
    else if (isUnsupported(entry.method)) {
      issues.push({ code: "NOT_SUPPORTED", details: { methods: [entry.method] } });
    } else if (entry.method === "CASH" && entry.amount % cashUnit !== 0n) {
      issues.push({ code: "CASH_NOT_IN_UNITS" });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  if (sum(entries.map((e) => e.amount)) !== netRefund) {
    return {
      ok: false,
      issues: [{ code: "PAYMENT_MISMATCH", details: { expected: netRefund.toString() } }],
    };
  }

  const left = new Map(caps);
  const rows = new Map<string, PlannedRefundPayment>();
  const add = (method: PaymentMethod, id: string, amount: Money, crossMethod: boolean): void => {
    const key = `${method}|${id}`;
    const row = rows.get(key);
    if (row) row.amount += amount;
    else rows.set(key, { method, amount, originalPaymentId: id, crossMethod });
    left.set(id, left.get(id)! - amount);
  };

  // Pass 1: same-method sources, newest first.
  const unmet: { method: PaymentMethod; amount: Money }[] = [];
  for (const entry of entries) {
    let need = entry.amount;
    for (let i = order.length - 1; i >= 0 && need > 0n; i--) {
      const id = order[i]!;
      if (methodOf.get(id) !== entry.method) continue;
      let give = min(need, left.get(id)!);
      if (entry.method === "CASH") give = floorTo(give, cashUnit);
      if (give <= 0n) continue;
      add(entry.method, id, give, false);
      need -= give;
    }
    if (need > 0n) unmet.push({ method: entry.method, amount: need });
  }

  // Pass 2: cross-method, from any tender with value left (unsupported ones first).
  const crossOrder = [...order].sort((a, b) => {
    const ua = isUnsupported(methodOf.get(a)!) ? 0 : 1;
    const ub = isUnsupported(methodOf.get(b)!) ? 0 : 1;
    return ua !== ub ? ua - ub : order.indexOf(b) - order.indexOf(a);
  });
  for (const miss of unmet) {
    if (!(CROSS_METHOD_TARGETS as readonly string[]).includes(miss.method)) {
      return {
        ok: false,
        issues: [{ code: "REFUND_METHOD_NOT_ALLOWED", details: { method: miss.method } }],
      };
    }
    let need = miss.amount;
    for (const id of crossOrder) {
      if (need === 0n) break;
      let give = min(need, left.get(id)!);
      if (miss.method === "CASH") give = floorTo(give, cashUnit);
      if (give <= 0n) continue;
      add(miss.method, id, give, methodOf.get(id) !== miss.method);
      need -= give;
    }
    if (need > 0n) return { ok: false, issues: [{ code: "ALLOCATION_FAILED" }] };
  }
  return { ok: true, rows: [...rows.values()] };
}
