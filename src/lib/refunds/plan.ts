/**
 * Client-side refund planning: turns what the cashier tapped (line quantities,
 * restock switches, reason, payout choice) into the SAME `planRefund` run the
 * server performs, so the preview total, tax split, rounding and payout rows
 * on screen are the numbers the server will compute (and `expectedTotal` pins
 * them: a difference is TOTAL_MISMATCH, never a silent change).
 *
 * Pure: no React, no I/O, no clock (callers pass `now`).
 */
import { hasPermission, type Role } from "@/domain/permissions";
import { isFractionalUnit, MILLI_PER_UNIT, parseQty } from "@/domain/qty";
import {
  lineProgress,
  planRefund,
  type LineProgress,
  type PaymentMethod,
  type RefundIssue,
  type RefundPlan,
  type RefundRequest,
  type ReturnReason,
} from "@/domain/refund";
import {
  refundApprovalRequirements,
  type RefundApprovalKey,
  type RefundApprovalRequirement,
  type RefundInputWire,
} from "@/domain/refund-contract";
import type { Money } from "@/domain/money";
import {
  toPreviousRefunds,
  toRefundSnapshot,
  type ReturnSale,
  type ReturnSaleLine,
} from "./sale-wire";

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface LineChoice {
  qtyMilli: number;
  restock: boolean;
}
/** saleLineId -> choice. Only lines with a positive quantity are present. */
export type Choices = Readonly<Record<string, LineChoice>>;

export const PAYOUT_METHODS = ["CASH", "CARD", "QPAY", "BANK_TRANSFER"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export type PayoutChoice =
  /** The original tenders, proportionally (the default, never needs approval). */
  | { kind: "ORIGINAL" }
  /** The whole net refund through one method (cross-method needs a manager). */
  | { kind: "METHOD"; method: PayoutMethod }
  /** Explicit split; must add up to the net refund. */
  | { kind: "CUSTOM"; entries: readonly { method: PayoutMethod; amount: Money }[] };

export interface Draft {
  choices: Choices;
  reason: ReturnReason | null;
  note: string;
  payout: PayoutChoice;
}

export const EMPTY_DRAFT: Draft = {
  choices: {},
  reason: null,
  note: "",
  payout: { kind: "ORIGINAL" },
};

export function progressOf(sale: ReturnSale): Map<string, LineProgress> {
  return new Map(
    lineProgress(toRefundSnapshot(sale), toPreviousRefunds(sale)).map((p) => [p.saleLineId, p]),
  );
}

/** Restock defaults to the product's tracking (services and untracked items have nothing to put back). */
export function defaultRestock(line: Pick<ReturnSaleLine, "tracksStock" | "isGiftCard">): boolean {
  return line.tracksStock && !line.isGiftCard;
}

/** A line can be returned at all: something remains and it is not a gift card. */
export function isReturnable(line: ReturnSaleLine, progress: LineProgress | undefined): boolean {
  return !line.isGiftCard && (progress?.remainingQtyMilli ?? 0) > 0;
}

/** Set a line's quantity (clamped to what remains; 0 removes the line from the draft). */
export function withQty(
  choices: Choices,
  line: ReturnSaleLine,
  progress: LineProgress,
  qtyMilli: number,
): Choices {
  const next = { ...choices };
  const clamped = Math.max(0, Math.min(Math.trunc(qtyMilli), progress.remainingQtyMilli));
  const whole = isFractionalUnit(line.unit) ? clamped : clamped - (clamped % MILLI_PER_UNIT); // pieces are whole units
  if (whole <= 0) {
    delete next[line.id];
    return next;
  }
  next[line.id] = { qtyMilli: whole, restock: choices[line.id]?.restock ?? defaultRestock(line) };
  return next;
}

/** +/- one whole unit for pieces, one tenth of a unit for weighed goods. */
export function stepSize(line: Pick<ReturnSaleLine, "unit">): number {
  return isFractionalUnit(line.unit) ? 100 : MILLI_PER_UNIT;
}

export function stepQty(
  choices: Choices,
  line: ReturnSaleLine,
  progress: LineProgress,
  direction: 1 | -1,
): Choices {
  const current = choices[line.id]?.qtyMilli ?? 0;
  const step = stepSize(line);
  // A weighed line stepping up from 0 starts at one step; stepping up to the
  // end lands exactly on the remainder (the last unit takes what is left).
  const target =
    direction === 1 ? Math.min(current + step, progress.remainingQtyMilli) : current - step;
  return withQty(choices, line, progress, target);
}

/** Return the whole remaining quantity of a line (the "all" shortcut). */
export function withAll(choices: Choices, line: ReturnSaleLine, progress: LineProgress): Choices {
  return withQty(choices, line, progress, progress.remainingQtyMilli);
}

export function withRestock(choices: Choices, lineId: string, restock: boolean): Choices {
  const current = choices[lineId];
  return current ? { ...choices, [lineId]: { ...current, restock } } : choices;
}

/** Typed quantity for a weighed line -> milli, within 1..remaining; null when not acceptable. */
export function parseTypedQty(
  text: string,
  line: ReturnSaleLine,
  remaining: number,
): number | null {
  const qty = parseQty(text, line.unit);
  return qty !== null && qty <= remaining ? qty : null;
}

export function selectedCount(choices: Choices): number {
  return Object.keys(choices).length;
}

// ---------------------------------------------------------------------------
// Preview (planRefund on the client)
// ---------------------------------------------------------------------------

export interface PreviewInput {
  /** Approval scopes embed this id, so a different id needs different tokens. */
  refundId: string;
  sale: ReturnSale;
  draft: Draft;
  now: Date;
  roundingUnit: Money;
  maxRefundWindowDays: number | null;
  role: Role;
  /** Exchange: the replacement sale's payable. */
  exchangeTotal?: Money | undefined;
}

export type Blocker = "REASON" | "NOTE";

export type Preview =
  | { kind: "empty" }
  /** The planner rejected the request (over-refund, bad payout, ...). */
  | { kind: "invalid"; issues: RefundIssue[]; blockers: Blocker[] }
  | {
      kind: "ok";
      plan: RefundPlan;
      /** Every approval this exact refund can need (always lists `refund`). */
      requirements: RefundApprovalRequirement[];
      /** The ones THIS user lacks the permission for: a manager must approve them. */
      needed: RefundApprovalRequirement[];
      /** Reason / note still missing: the plan is valid, submitting is not allowed yet. */
      blockers: Blocker[];
      outsideWindow: boolean;
    };

export function blockersOf(draft: Draft): Blocker[] {
  const out: Blocker[] = [];
  if (draft.reason === null) out.push("REASON");
  else if (draft.reason === "OTHER" && draft.note.trim() === "") out.push("NOTE");
  return out;
}

/** Permissions the user's role holds for each approval key (a manager needs no token). */
export function roleHolds(role: Role, key: RefundApprovalKey): boolean {
  return key === "refund"
    ? hasPermission(role, "pos.refund")
    : hasPermission(role, "pos.refund.approve");
}

export function requestOf(
  draft: Draft,
  netRefund: Money | null,
  exchangeTotal?: Money,
): RefundRequest {
  let paymentOverride: RefundRequest["paymentOverride"];
  if (draft.payout.kind === "METHOD" && netRefund !== null && netRefund > 0n) {
    paymentOverride = [{ method: draft.payout.method, amount: netRefund }];
  } else if (draft.payout.kind === "CUSTOM") {
    paymentOverride = draft.payout.entries.filter((e) => e.amount > 0n).map((e) => ({ ...e }));
  }
  return {
    // The planner needs a reason to validate; a missing one is a UI blocker, not a math input.
    reason: draft.reason ?? "CHANGED_MIND",
    note: draft.reason === "OTHER" ? "-" : draft.note,
    lines: Object.entries(draft.choices).map(([saleLineId, c]) => ({
      saleLineId,
      qtyMilli: c.qtyMilli,
      restock: c.restock,
    })),
    ...(paymentOverride ? { paymentOverride } : {}),
    ...(exchangeTotal !== undefined ? { exchangeSaleTotal: exchangeTotal } : {}),
  };
}

export function previewRefund(input: PreviewInput): Preview {
  const { sale, draft } = input;
  if (selectedCount(draft.choices) === 0) return { kind: "empty" };
  const blockers = blockersOf(draft);
  const snapshot = toRefundSnapshot(sale);
  const previous = toPreviousRefunds(sale);
  const context = {
    shiftOpen: true,
    now: input.now,
    roundingUnit: input.roundingUnit,
    policy: { maxRefundWindowDays: input.maxRefundWindowDays },
    // Grants only gate approvals; the requirements are computed from the plan below.
    grants: { refund: true, methodOverride: true, outsideWindow: true },
  };
  try {
    let result = planRefund(
      snapshot,
      previous,
      requestOf(draft, null, input.exchangeTotal),
      context,
    );
    if (result.ok && draft.payout.kind === "METHOD") {
      const net = result.plan.totalAmount - (result.plan.exchange?.creditApplied ?? 0n);
      result = planRefund(snapshot, previous, requestOf(draft, net, input.exchangeTotal), context);
    }
    if (!result.ok) return { kind: "invalid", issues: result.issues, blockers };
    const { plan } = result;
    const requirements = refundApprovalRequirements(input.refundId, sale.id, plan);
    return {
      kind: "ok",
      plan,
      requirements,
      needed: requirements.filter((r) => !roleHolds(input.role, r.key)),
      blockers,
      outsideWindow: plan.needs.outsideWindow,
    };
  } catch {
    // lineProgress / paymentCapacities throw on rows that contradict each other.
    return { kind: "invalid", issues: [{ code: "ALLOCATION_FAILED" }], blockers };
  }
}

// ---------------------------------------------------------------------------
// Approvals held on screen
// ---------------------------------------------------------------------------

export interface HeldApproval {
  token: string;
  /** The exact scope the token was minted for. */
  scope: string;
  approverName: string;
}
export type HeldApprovals = Readonly<Record<string, HeldApproval>>;

/** Requirements that still lack a token minted for THEIR CURRENT scope. */
export function missingApprovals(
  needed: readonly RefundApprovalRequirement[],
  held: HeldApprovals,
): RefundApprovalRequirement[] {
  return needed.filter((r) => held[r.key]?.scope !== r.scope);
}

/** Tokens to send: only those that match a requirement's current scope. */
export function approvalTokensFor(
  requirements: readonly RefundApprovalRequirement[],
  held: HeldApprovals,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of requirements) {
    const h = held[r.key];
    if (h && h.scope === r.scope) out[r.key] = h.token;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire input
// ---------------------------------------------------------------------------

export interface BuildRefundInput {
  refundId: string;
  sale: ReturnSale;
  draft: Draft;
  plan: RefundPlan;
  approvals: Record<string, string>;
  exchange?: { saleId: string; expectedPayable: Money } | undefined;
  now?: Date;
}

/** Wire input for `refundAction`. Money as decimal strings. */
export function buildRefundInput(input: BuildRefundInput): RefundInputWire {
  const { draft, plan } = input;
  const note = draft.note.trim();
  const override =
    draft.payout.kind === "ORIGINAL"
      ? undefined
      : plan.payments
          .filter((p) => p.method !== "EXCHANGE_CREDIT")
          .reduce<{ method: PaymentMethod; amount: Money }[]>((acc, p) => {
            const hit = acc.find((a) => a.method === p.method);
            if (hit) hit.amount += p.amount;
            else acc.push({ method: p.method, amount: p.amount });
            return acc;
          }, []);
  return {
    refundId: input.refundId,
    saleId: input.sale.id,
    lines: Object.entries(draft.choices).map(([saleLineId, c]) => ({
      saleLineId,
      qtyMilli: c.qtyMilli,
      restock: c.restock,
    })),
    // `blockersOf` guarantees a reason before anything is sent.
    reason: draft.reason ?? "CHANGED_MIND",
    ...(note ? { note } : {}),
    ...(override && override.length > 0
      ? { payments: override.map((p) => ({ method: p.method, amount: p.amount.toString() })) }
      : {}),
    expectedTotal: plan.totalAmount.toString(),
    ...(input.exchange
      ? {
          exchange: {
            saleId: input.exchange.saleId,
            expectedPayable: input.exchange.expectedPayable.toString(),
          },
        }
      : {}),
    approvals: input.approvals,
    createdAtClient: (input.now ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Payout rows grouped by method (the exchange credit is shown apart). */
export function payoutRows(plan: RefundPlan): { method: PaymentMethod; amount: Money }[] {
  const out: { method: PaymentMethod; amount: Money }[] = [];
  for (const p of plan.payments) {
    if (p.method === "EXCHANGE_CREDIT") continue;
    const hit = out.find((o) => o.method === p.method);
    if (hit) hit.amount += p.amount;
    else out.push({ method: p.method, amount: p.amount });
  }
  return out;
}

/** True when any payout row goes through a tender other than the one that was paid. */
export function hasCrossMethod(plan: RefundPlan): boolean {
  return plan.payments.some((p) => p.crossMethod);
}

/** Whole days between the sale and now (the window check's unit). */
export function saleAgeDays(sale: Pick<ReturnSale, "occurredAt">, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - new Date(sale.occurredAt).getTime()) / 86_400_000),
  );
}

/** Per-line status for the lines table. */
export type LineState = "AVAILABLE" | "PARTIAL" | "DONE" | "GIFT_CARD";
export function lineState(line: ReturnSaleLine, progress: LineProgress | undefined): LineState {
  if (line.isGiftCard) return "GIFT_CARD";
  if (!progress || progress.remainingQtyMilli === 0) return "DONE";
  return progress.refundedQtyMilli > 0 ? "PARTIAL" : "AVAILABLE";
}

/** Sale-level state for badges and for deciding what can still be done. */
export type SaleState = "OK" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOIDED";
export function saleState(sale: ReturnSale): SaleState {
  if (sale.status === "VOIDED") return "VOIDED";
  if (sale.refunds.length === 0) return "OK";
  const progress = progressOf(sale);
  const anyLeft = sale.lines.some(
    (l) => !l.isGiftCard && (progress.get(l.id)?.remainingQtyMilli ?? 0) > 0,
  );
  return anyLeft ? "PARTIALLY_REFUNDED" : "REFUNDED";
}
