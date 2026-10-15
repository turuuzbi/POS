import { describe, expect, it } from "vitest";
import { toWire } from "./checkout-contract";
import { fromMajor } from "./money";
import { planRefund, type RefundIssue, type RefundSaleSnapshot } from "./refund";
import {
  REFUND_ERROR_CODES,
  REFUND_ERROR_MESSAGE_KEYS,
  isRefundApprovalScope,
  isSameRefund,
  refundApprovalKeys,
  refundApprovalRequirements,
  refundErrorFromIssues,
  refundFingerprint,
  refundRequestSchema,
  refundResultFromPlan,
  refundResultSchema,
  toPlanRequest,
  type RefundInput,
  type RefundInputWire,
} from "./refund-contract";

const T = fromMajor;
const REFUND_ID = "01900000-0000-7000-8000-000000000001";
const SALE_ID = "01900000-0000-7000-8000-000000000002";
const LINE_A = "01900000-0000-7000-8000-00000000000a";
const LINE_B = "01900000-0000-7000-8000-00000000000b";
const EX_ID = "01900000-0000-7000-8000-000000000003";

const wire = (extra: Partial<RefundInputWire> = {}): RefundInputWire => ({
  refundId: REFUND_ID,
  saleId: SALE_ID,
  lines: [
    { saleLineId: LINE_A, qtyMilli: 1000, restock: true },
    { saleLineId: LINE_B, qtyMilli: 500, restock: false, reason: "DAMAGED" },
  ],
  reason: "CHANGED_MIND",
  expectedTotal: "1000000",
  approvals: {},
  createdAtClient: "2026-10-15T10:00:00+08:00",
  ...extra,
});
const parse = (extra: Partial<RefundInputWire> = {}): RefundInput =>
  refundRequestSchema.parse(wire(extra));

describe("refundRequestSchema", () => {
  it("parses money to bigint and lowercases ids", () => {
    const i = parse({ payments: [{ method: "CASH", amount: "500000" }] });
    expect(i.expectedTotal).toBe(1_000_000n);
    expect(i.payments?.[0]?.amount).toBe(500_000n);
    expect(refundRequestSchema.parse(wire({ refundId: REFUND_ID.toUpperCase() })).refundId).toBe(
      REFUND_ID,
    );
  });
  it.each([
    ["non-v7 refund id", { refundId: "550e8400-e29b-41d4-a716-446655440000" }],
    ["no lines", { lines: [] }],
    ["fractional qty", { lines: [{ saleLineId: LINE_A, qtyMilli: 1.5, restock: true }] }],
    ["zero qty", { lines: [{ saleLineId: LINE_A, qtyMilli: 0, restock: true }] }],
    [
      "duplicate line",
      {
        lines: [
          { saleLineId: LINE_A, qtyMilli: 1000, restock: true },
          { saleLineId: LINE_A, qtyMilli: 1000, restock: true },
        ],
      },
    ],
    ["unknown reason", { reason: "BORED" as never }],
    ["zero override amount", { payments: [{ method: "CASH", amount: "0" }] }],
    ["negative total", { expectedTotal: "-5" }],
    ["exchange with the same sale", { exchange: { saleId: SALE_ID, expectedPayable: "100" } }],
    ["exchange with 0 payable", { exchange: { saleId: EX_ID, expectedPayable: "0" } }],
    ["bad clock", { createdAtClient: "yesterday" }],
  ])("rejects %s", (_name, extra) => {
    expect(refundRequestSchema.safeParse(wire(extra as Partial<RefundInputWire>)).success).toBe(
      false,
    );
  });
  it("accepts an exchange reference", () => {
    const i = parse({ exchange: { saleId: EX_ID, expectedPayable: "2500000" } });
    expect(toPlanRequest(i).exchangeSaleTotal).toBe(2_500_000n);
  });
});

describe("error codes", () => {
  it("every code has a message key", () => {
    for (const code of REFUND_ERROR_CODES) {
      expect(REFUND_ERROR_MESSAGE_KEYS[code]).toBe(`refund.errors.${code}`);
    }
    expect(new Set(REFUND_ERROR_CODES).size).toBe(REFUND_ERROR_CODES.length);
    for (const needed of [
      "SHIFT_NOT_OPEN",
      "ALREADY_REFUNDED",
      "OVER_REFUND",
      "APPROVAL_REQUIRED",
      "REFUND_METHOD_NOT_ALLOWED",
      "NOT_SUPPORTED",
      "IDEMPOTENCY_CONFLICT",
    ]) {
      expect(REFUND_ERROR_CODES).toContain(needed);
    }
  });
  it("maps planner issues, first one wins", () => {
    const issues: RefundIssue[] = [
      { code: "OVER_REFUND", saleLineId: LINE_A },
      { code: "ALREADY_REFUNDED", saleLineId: LINE_B },
    ];
    expect(refundErrorFromIssues(issues)).toMatchObject({
      code: "OVER_REFUND",
      messageKey: "refund.errors.OVER_REFUND",
    });
    expect(refundErrorFromIssues([]).code).toBe("INVALID_INPUT");
  });
});

describe("refundFingerprint", () => {
  it("ignores approvals, clock, refund id and line order", () => {
    const a = parse();
    const b = parse({
      refundId: "01900000-0000-7000-8000-0000000000ff",
      approvals: { refund: "tok" },
      createdAtClient: "2026-10-16T00:00:00Z",
      lines: [...wire().lines].reverse(),
    });
    expect(refundFingerprint(a)).toBe(refundFingerprint(b));
    expect(isSameRefund(refundFingerprint(a), b)).toBe(true);
  });
  it("changes with any content", () => {
    const base = refundFingerprint(parse());
    const variants: Partial<RefundInputWire>[] = [
      { expectedTotal: "1000001" },
      { reason: "DEFECTIVE" },
      { note: "x" },
      { lines: [{ saleLineId: LINE_A, qtyMilli: 2000, restock: true }] },
      { lines: [{ saleLineId: LINE_A, qtyMilli: 1000, restock: false }] },
      { payments: [{ method: "CASH", amount: "1000000" }] },
      { exchange: { saleId: EX_ID, expectedPayable: "5" } },
      { saleId: "01900000-0000-7000-8000-0000000000aa" },
    ];
    for (const v of variants) expect(refundFingerprint(parse(v))).not.toBe(base);
    expect(isSameRefund(base, parse({ note: "x" }))).toBe(false);
  });
});

describe("approvals", () => {
  const sale: RefundSaleSnapshot = {
    id: SALE_ID,
    status: "COMPLETED",
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    shiftId: "s",
    totalAmount: T(30_000),
    tipAmount: 0n,
    roundingAmount: 0n,
    lines: [
      {
        id: LINE_A,
        variantId: "v",
        unit: "PIECE",
        qtyMilli: 3000,
        totalAmount: T(30_000),
        netAmount: T(30_000),
        vatAmount: 0n,
        cityTaxAmount: 0n,
        unitCost: 0n,
      },
    ],
    payments: [{ id: "card", method: "CARD", amount: T(30_000) }],
  };
  const make = (qty: number, extra = {}) => {
    const r = planRefund(
      sale,
      [],
      {
        lines: [{ saleLineId: LINE_A, qtyMilli: qty, restock: true }],
        reason: "CHANGED_MIND",
        ...extra,
      },
      {
        shiftOpen: true,
        now: new Date("2026-10-15T00:00:00Z"),
        roundingUnit: 100n,
        policy: { maxRefundWindowDays: 7 },
        grants: { refund: false, methodOverride: false, outsideWindow: false },
      },
    );
    if (r.ok || !r.preview) throw new Error("expected a preview");
    return r.preview;
  };

  it("scopes are bound to refund id, lines, qty and total", () => {
    const one = refundApprovalRequirements(REFUND_ID, SALE_ID, make(1000));
    const two = refundApprovalRequirements(REFUND_ID, SALE_ID, make(2000));
    expect(one[0]!.key).toBe(refundApprovalKeys.refund);
    expect(one[0]!.scope).not.toBe(two[0]!.scope);
    const other = refundApprovalRequirements(
      "01900000-0000-7000-8000-0000000000ee",
      SALE_ID,
      make(1000),
    );
    expect(other[0]!.scope).not.toBe(one[0]!.scope);
    // deterministic
    expect(refundApprovalRequirements(REFUND_ID, SALE_ID, make(1000))).toEqual(one);
    for (const req of one) {
      expect(req.permission).toBe("pos.refund.approve");
      expect(req.scope.length).toBeLessThanOrEqual(200);
      expect(isRefundApprovalScope(req.scope)).toBe(true);
    }
  });

  it("window and payout approvals appear only when needed and bind their value", () => {
    const plain = refundApprovalRequirements(REFUND_ID, SALE_ID, make(1000));
    expect(plain.map((r) => r.key)).toEqual(["refund", "refund:window"]);
    const cash = make(1000, { paymentOverride: [{ method: "CASH", amount: T(10_000) }] });
    const reqs = refundApprovalRequirements(REFUND_ID, SALE_ID, cash);
    expect(reqs.map((r) => r.key)).toEqual(["refund", "refund:method", "refund:window"]);
    const bank = make(1000, { paymentOverride: [{ method: "BANK_TRANSFER", amount: T(10_000) }] });
    const bankReqs = refundApprovalRequirements(REFUND_ID, SALE_ID, bank);
    expect(bankReqs[1]!.scope).not.toBe(reqs[1]!.scope);
    for (const r of reqs) expect(isRefundApprovalScope(r.scope)).toBe(true);
  });

  it("scope shape rejects foreign scopes", () => {
    expect(isRefundApprovalScope(SALE_ID)).toBe(false);
    expect(isRefundApprovalScope(`${SALE_ID}:void:100`)).toBe(false);
    expect(isRefundApprovalScope(`${REFUND_ID}:refund:x`)).toBe(false);
  });
});

describe("result", () => {
  it("round-trips through the wire", () => {
    const sale: RefundSaleSnapshot = {
      id: SALE_ID,
      status: "COMPLETED",
      occurredAt: new Date(),
      shiftId: "s",
      totalAmount: T(1000),
      tipAmount: 0n,
      roundingAmount: 0n,
      lines: [
        {
          id: LINE_A,
          variantId: "v",
          unit: "PIECE",
          qtyMilli: 1000,
          totalAmount: T(1000),
          netAmount: T(1000),
          vatAmount: 0n,
          cityTaxAmount: 0n,
          unitCost: 0n,
        },
      ],
      payments: [{ id: LINE_B, method: "CASH", amount: T(1000) }],
    };
    const plan = planRefund(
      sale,
      [],
      { lines: [{ saleLineId: LINE_A, qtyMilli: 1000, restock: true }], reason: "DEFECTIVE" },
      {
        shiftOpen: true,
        now: new Date(),
        roundingUnit: 100n,
        grants: { refund: true, methodOverride: false, outsideWindow: false },
      },
    );
    if (!plan.ok) throw new Error("plan");
    const result = refundResultFromPlan(
      { refundId: REFUND_ID, saleId: SALE_ID, exchange: undefined },
      "UB1-R-000001",
      plan.plan,
      false,
    );
    const parsed = refundResultSchema.parse(JSON.parse(JSON.stringify(toWire(result))));
    expect(parsed).toEqual(result);
    expect(parsed.cashRefund).toBe(T(1000));
  });
});
