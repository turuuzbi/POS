/**
 * Refund / return / exchange wire contract (Phase 3): the request the client
 * sends, the result, stable error codes with message keys, the idempotency
 * fingerprint and the approval scopes (each bound to the exact value being
 * approved, in the spirit of `approvalScope` in discounts.ts).
 *
 * Money crosses JSON as decimal strings of möngö. register, shift, cashier and
 * location come from the device session. The refund total is NEVER taken from
 * the client: `expectedTotal` only pins what the cashier saw, and a mismatch
 * with the server's `planRefund` is TOTAL_MISMATCH.
 */
import { z } from "zod";
import {
  moneyWire,
  optionalText,
  sha256Hex,
  signedMoneyWire,
  stableStringify,
  uuid,
  uuidV7,
} from "./checkout-contract";
import {
  MAX_REFUND_LINES,
  PAYMENT_METHODS,
  RETURN_REASONS,
  type RefundIssue,
  type RefundPlan,
  type RefundRequest,
} from "./refund";
import { MAX_QTY_MILLI } from "./qty";

export const MAX_REFUND_PAYMENT_ENTRIES = 6;
export const MAX_REFUND_NOTE_LENGTH = 500;

export const refundLineRequestSchema = z.strictObject({
  saleLineId: uuid,
  qtyMilli: z.number().int().positive().max(MAX_QTY_MILLI),
  restock: z.boolean(),
  reason: z.enum(RETURN_REASONS).optional(),
});

export const refundPaymentOverrideSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  amount: moneyWire.refine((v) => v > 0n, "must be positive"),
});

export const refundRequestSchema = z
  .strictObject({
    /** Client-generated UUIDv7: idempotency key and Refund.id. */
    refundId: uuidV7,
    saleId: uuidV7,
    lines: z.array(refundLineRequestSchema).min(1).max(MAX_REFUND_LINES),
    reason: z.enum(RETURN_REASONS),
    note: optionalText(MAX_REFUND_NOTE_LENGTH),
    /** Manager override of the payout methods (covers the NET refund after exchange credit). */
    payments: z.array(refundPaymentOverrideSchema).max(MAX_REFUND_PAYMENT_ENTRIES).optional(),
    /** Refund total the cashier saw (items + tip + rounding). */
    expectedTotal: moneyWire,
    /**
     * Exchange: the replacement sale is a separate checkout with this id. The
     * server verifies it carries `expectedPayable` and links it as
     * Refund.exchangeSaleId in the same transaction.
     */
    exchange: z
      .object({
        saleId: uuidV7,
        expectedPayable: moneyWire.refine((v) => v > 0n, "must be positive"),
      })
      .optional(),
    /** Approval tokens by key (`refundApprovalKeys`). */
    approvals: z.record(z.string().max(100), z.string().min(1).max(512)).default({}),
    createdAtClient: z.iso.datetime({ offset: true }),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.lines.forEach((line, i) => {
      if (seen.has(line.saleLineId)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "saleLineId"],
          message: "duplicate saleLineId",
        });
      }
      seen.add(line.saleLineId);
    });
    if (input.exchange && input.exchange.saleId === input.saleId) {
      ctx.addIssue({ code: "custom", path: ["exchange", "saleId"], message: "same as saleId" });
    }
  });

export type RefundInput = z.output<typeof refundRequestSchema>;
/** What a JSON client puts on the wire (money as strings). */
export type RefundInputWire = z.input<typeof refundRequestSchema>;

/** Input → the pure planner's request. */
export function toPlanRequest(input: RefundInput): RefundRequest {
  return {
    lines: input.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      restock: l.restock,
      reason: l.reason,
    })),
    reason: input.reason,
    note: input.note,
    paymentOverride: input.payments?.map((p) => ({ method: p.method, amount: p.amount })),
    exchangeSaleTotal: input.exchange?.expectedPayable,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const REFUND_ERROR_CODES = [
  "INVALID_INPUT",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "SHIFT_NOT_OPEN",
  "SALE_NOT_FOUND",
  "SALE_NOT_COMPLETED",
  "NO_LINES",
  "TOO_MANY_LINES",
  "DUPLICATE_LINE",
  "UNKNOWN_LINE",
  "INVALID_QUANTITY",
  "ALREADY_REFUNDED",
  "OVER_REFUND",
  "REASON_NOTE_REQUIRED",
  "NOT_SUPPORTED",
  "REFUND_METHOD_NOT_ALLOWED",
  "PAYMENT_MISMATCH",
  "CASH_NOT_IN_UNITS",
  "ALLOCATION_FAILED",
  "REFUND_WINDOW_EXCEEDED",
  "EXCHANGE_INVALID",
  "EXCHANGE_MISMATCH",
  "TOTAL_MISMATCH",
  "PAYMENT_PROVIDER_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "CONCURRENT_DUPLICATE",
  "INTERNAL",
] as const;
export type RefundErrorCode = (typeof REFUND_ERROR_CODES)[number];

/** i18n key (namespace `refund.errors`) per code. */
export const REFUND_ERROR_MESSAGE_KEYS: Record<RefundErrorCode, string> = Object.fromEntries(
  REFUND_ERROR_CODES.map((code) => [code, `refund.errors.${code}`]),
) as Record<RefundErrorCode, string>;

export interface RefundError {
  code: RefundErrorCode;
  messageKey: string;
  details?: Record<string, unknown>;
}

export function refundError(code: RefundErrorCode, details?: Record<string, unknown>): RefundError {
  return { code, messageKey: REFUND_ERROR_MESSAGE_KEYS[code], ...(details ? { details } : {}) };
}

// Compile-time: every planner issue code is a contract code.
const _issueCodesAreContractCodes: RefundIssue["code"] extends RefundErrorCode ? true : never =
  true;
void _issueCodesAreContractCodes;

/** First planner issue → API error; all issues are listed in details. */
export function refundErrorFromIssues(issues: readonly RefundIssue[]): RefundError {
  const first = issues[0];
  return refundError(first?.code ?? "INVALID_INPUT", {
    issues: issues.map((i) => ({
      code: i.code,
      ...(i.saleLineId ? { saleLineId: i.saleLineId } : {}),
      ...(i.details ? { details: i.details } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface RefundResult {
  refundId: string;
  receiptNumber: string;
  saleId: string;
  totals: {
    itemsTotal: bigint;
    netAmount: bigint;
    vatAmount: bigint;
    cityTaxAmount: bigint;
    tipAmount: bigint;
    roundingAmount: bigint;
    totalAmount: bigint;
  };
  lines: { saleLineId: string; qtyMilli: number; restock: boolean; totalAmount: bigint }[];
  payments: {
    method: (typeof PAYMENT_METHODS)[number];
    amount: bigint;
    originalPaymentId: string | null;
  }[];
  /** Cash to hand to the customer from the drawer. */
  cashRefund: bigint;
  exchange: null | {
    saleId: string;
    creditApplied: bigint;
    netDue: bigint;
    netRefund: bigint;
  };
  completesSale: boolean;
  /** True when the refundId was already committed and this is the stored refund. */
  replayed: boolean;
}

export const refundResultSchema = z.object({
  refundId: uuidV7,
  receiptNumber: z.string().min(1),
  saleId: uuidV7,
  totals: z.object({
    itemsTotal: signedMoneyWire,
    netAmount: signedMoneyWire,
    vatAmount: signedMoneyWire,
    cityTaxAmount: signedMoneyWire,
    tipAmount: signedMoneyWire,
    roundingAmount: signedMoneyWire,
    totalAmount: signedMoneyWire,
  }),
  lines: z.array(
    z.object({
      saleLineId: uuid,
      qtyMilli: z.number().int().positive(),
      restock: z.boolean(),
      totalAmount: signedMoneyWire,
    }),
  ),
  payments: z.array(
    z.object({
      method: z.enum(PAYMENT_METHODS),
      amount: signedMoneyWire,
      originalPaymentId: uuid.nullable(),
    }),
  ),
  cashRefund: signedMoneyWire,
  exchange: z
    .object({
      saleId: uuidV7,
      creditApplied: signedMoneyWire,
      netDue: signedMoneyWire,
      netRefund: signedMoneyWire,
    })
    .nullable(),
  completesSale: z.boolean(),
  replayed: z.boolean(),
});

/** Build the result from the planner's output (server, after the transaction). */
export function refundResultFromPlan(
  input: Pick<RefundInput, "refundId" | "saleId" | "exchange">,
  receiptNumber: string,
  plan: RefundPlan,
  replayed: boolean,
): RefundResult {
  return {
    refundId: input.refundId,
    receiptNumber,
    saleId: input.saleId,
    totals: {
      itemsTotal: plan.itemsTotal,
      netAmount: plan.netAmount,
      vatAmount: plan.vatAmount,
      cityTaxAmount: plan.cityTaxAmount,
      tipAmount: plan.tipAmount,
      roundingAmount: plan.roundingAmount,
      totalAmount: plan.totalAmount,
    },
    lines: plan.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      restock: l.restock,
      totalAmount: l.totalAmount,
    })),
    payments: plan.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      originalPaymentId: p.originalPaymentId,
    })),
    cashRefund: plan.cashRefund,
    exchange:
      plan.exchange && input.exchange
        ? {
            saleId: input.exchange.saleId,
            creditApplied: plan.exchange.creditApplied,
            netDue: plan.exchange.netDue,
            netRefund: plan.exchange.netRefund,
          }
        : null,
    completesSale: plan.completesSale,
    replayed,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical string of WHAT is refunded: sale, lines (sorted by saleLineId, so
 * the order the cashier tapped them in does not matter), reasons, restock
 * flags, payout override (order significant), expected total and exchange.
 * Excluded: `approvals` (re-minted on retry), `createdAtClient` (clock) and
 * `refundId` (it is the key the fingerprint is stored under).
 */
export function canonicalizeRefundInput(input: RefundInput): string {
  const { approvals: _approvals, createdAtClient: _created, refundId: _id, ...content } = input;
  const lines = [...content.lines].sort((a, b) =>
    a.saleLineId < b.saleLineId ? -1 : a.saleLineId > b.saleLineId ? 1 : 0,
  );
  return stableStringify({ ...content, lines });
}

export function refundFingerprint(input: RefundInput): string {
  return sha256Hex(canonicalizeRefundInput(input));
}

/** True when a replay carries the same content as the stored refund. */
export function isSameRefund(storedFingerprint: string, input: RefundInput): boolean {
  return storedFingerprint === refundFingerprint(input);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Keys into `RefundInput.approvals`. All three need permission `pos.refund.approve`. */
export const refundApprovalKeys = {
  /** A cashier without `pos.refund` refunding this exact sale, lines and total. */
  refund: "refund",
  /** Paying out through a method other than the original tender (the exact payout rows). */
  methodOverride: "refund:method",
  /** Refunding outside the configured window. */
  outsideWindow: "refund:window",
} as const;
export type RefundApprovalKey = (typeof refundApprovalKeys)[keyof typeof refundApprovalKeys];

export interface RefundApprovalRequirement {
  key: RefundApprovalKey;
  permission: "pos.refund.approve";
  /** Canonical text of what is approved (for display and audit). */
  value: string;
  /** What the token must carry (`<refundId>:<kind>:…`, at most 200 chars). */
  scope: string;
}

const digest = (text: string): string => sha256Hex(text).slice(0, 16);

function linesDigest(lines: readonly { saleLineId: string; qtyMilli: number; restock: boolean }[]) {
  return digest(
    stableStringify(
      [...lines]
        .sort((a, b) => (a.saleLineId < b.saleLineId ? -1 : a.saleLineId > b.saleLineId ? 1 : 0))
        .map((l) => [l.saleLineId, l.qtyMilli, l.restock]),
    ),
  );
}

/**
 * Approvals this refund needs, computed from the server-side plan. Each scope
 * is bound to the exact value: the sale, the lines + quantities + restock
 * flags and the refund total (`refund`); the exact payout rows
 * (`refund:method`); the sale (`refund:window`). A token minted for one
 * refund amount, line set or payout cannot approve another.
 *
 * `refund` is always listed; the caller skips it for actors holding `pos.refund`.
 */
export function refundApprovalRequirements(
  refundId: string,
  saleId: string,
  plan: Pick<RefundPlan, "lines" | "totalAmount" | "payments" | "needs">,
): RefundApprovalRequirement[] {
  const out: RefundApprovalRequirement[] = [];
  const lines = linesDigest(plan.lines);
  out.push({
    key: refundApprovalKeys.refund,
    permission: "pos.refund.approve",
    value: `sale:${saleId}|total:${plan.totalAmount}|lines:${lines}`,
    scope: `${refundId}:refund:${saleId}:${plan.totalAmount}:${lines}`,
  });
  if (plan.needs.methodOverride) {
    const payout = digest(
      stableStringify(
        plan.payments.map((p) => [p.method, p.amount, p.originalPaymentId, p.crossMethod]),
      ),
    );
    out.push({
      key: refundApprovalKeys.methodOverride,
      permission: "pos.refund.approve",
      value: `payout:${payout}|total:${plan.totalAmount}`,
      scope: `${refundId}:refund:method:${plan.totalAmount}:${payout}`,
    });
  }
  if (plan.needs.outsideWindow) {
    out.push({
      key: refundApprovalKeys.outsideWindow,
      permission: "pos.refund.approve",
      value: `sale:${saleId}`,
      scope: `${refundId}:refund:window:${saleId}`,
    });
  }
  return out;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFUND_SCOPE_SHAPE = new RegExp(
  `^${UUID}:refund:(?:${UUID}:\\d+:[0-9a-f]{16}|method:\\d+:[0-9a-f]{16}|window:${UUID})$`,
  "i",
);
export function isRefundApprovalScope(scope: string): boolean {
  return REFUND_SCOPE_SHAPE.test(scope);
}
