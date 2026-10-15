import { describe, expect, it } from "vitest";
import { planRefund } from "@/domain/refund";
import { refundRequestSchema } from "@/domain/refund-contract";
import {
  approvalTokensFor,
  blockersOf,
  buildRefundInput,
  EMPTY_DRAFT,
  missingApprovals,
  payoutRows,
  previewRefund,
  progressOf,
  saleAgeDays,
  saleState,
  stepQty,
  withAll,
  withQty,
  withRestock,
  type Draft,
  type PreviewInput,
} from "./plan";
import { toPreviousRefunds, toRefundSnapshot } from "./sale-wire";
import { IDS, makeSale } from "./test-fixtures";

const NOW = new Date("2026-10-15T10:00:00.000Z");

function input(overrides: Partial<PreviewInput> & { draft: Draft }): PreviewInput {
  return {
    refundId: IDS.newRefund,
    sale: makeSale(),
    now: NOW,
    roundingUnit: 100n,
    maxRefundWindowDays: null,
    role: "CASHIER",
    ...overrides,
  };
}

const sale = makeSale();
const milk = sale.lines[0]!;
const apples = sale.lines[1]!;
const book = sale.lines[2]!;
const progress = progressOf(sale);

describe("quantity choices", () => {
  it("steps pieces by one whole unit and stops at what remains", () => {
    let choices = stepQty({}, milk, progress.get(milk.id)!, 1);
    expect(choices[milk.id]?.qtyMilli).toBe(1000);
    choices = stepQty(choices, milk, progress.get(milk.id)!, 1);
    choices = stepQty(choices, milk, progress.get(milk.id)!, 1);
    expect(choices[milk.id]?.qtyMilli).toBe(2000);
    choices = stepQty(choices, milk, progress.get(milk.id)!, -1);
    choices = stepQty(choices, milk, progress.get(milk.id)!, -1);
    expect(choices[milk.id]).toBeUndefined();
  });

  it("steps weighed lines by a tenth and lands exactly on the remainder", () => {
    const p = progress.get(apples.id)!;
    let choices = withQty({}, apples, p, 1450);
    choices = stepQty(choices, apples, p, 1);
    expect(choices[apples.id]?.qtyMilli).toBe(1500);
    choices = stepQty(choices, apples, p, 1);
    expect(choices[apples.id]?.qtyMilli).toBe(1500);
  });

  it("clamps typed quantities and keeps pieces whole", () => {
    expect(withQty({}, apples, progress.get(apples.id)!, 9999)[apples.id]?.qtyMilli).toBe(1500);
    expect(withQty({}, milk, progress.get(milk.id)!, 1500)[milk.id]?.qtyMilli).toBe(1000);
    expect(withQty({}, milk, progress.get(milk.id)!, 0)[milk.id]).toBeUndefined();
  });

  it("defaults restock to the product's stock tracking and keeps the choice on later steps", () => {
    let choices = withAll({}, book, progress.get(book.id)!);
    expect(choices[book.id]?.restock).toBe(false);
    choices = withAll(choices, milk, progress.get(milk.id)!);
    expect(choices[milk.id]?.restock).toBe(true);
    choices = withRestock(choices, milk.id, false);
    choices = stepQty(choices, milk, progress.get(milk.id)!, -1);
    expect(choices[milk.id]).toEqual({ qtyMilli: 1000, restock: false });
  });
});

describe("previewRefund equals the domain planner", () => {
  it("returns the same plan planRefund gives for the same request", () => {
    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "DEFECTIVE",
      choices: {
        [milk.id]: { qtyMilli: 1000, restock: true },
        [apples.id]: { qtyMilli: 700, restock: false },
      },
    };
    const preview = previewRefund(input({ draft }));
    expect(preview.kind).toBe("ok");
    if (preview.kind !== "ok") return;
    const direct = planRefund(
      toRefundSnapshot(sale),
      toPreviousRefunds(sale),
      {
        reason: "DEFECTIVE",
        lines: [
          { saleLineId: milk.id, qtyMilli: 1000, restock: true },
          { saleLineId: apples.id, qtyMilli: 700, restock: false },
        ],
      },
      {
        shiftOpen: true,
        now: NOW,
        roundingUnit: 100n,
        grants: { refund: true, methodOverride: true, outsideWindow: true },
      },
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(preview.plan.totalAmount).toBe(direct.plan.totalAmount);
    expect(preview.plan.vatAmount).toBe(direct.plan.vatAmount);
    expect(preview.plan.roundingAmount).toBe(direct.plan.roundingAmount);
    expect(preview.plan.payments).toEqual(direct.plan.payments);
    // and the money adds up
    expect(preview.plan.itemsTotal + preview.plan.roundingAmount + preview.plan.tipAmount).toBe(
      preview.plan.totalAmount,
    );
  });

  it("is empty with nothing selected and reports planner issues", () => {
    expect(previewRefund(input({ draft: EMPTY_DRAFT })).kind).toBe("empty");
    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "DEFECTIVE",
      choices: { [milk.id]: { qtyMilli: 5000, restock: true } },
    };
    const preview = previewRefund(input({ draft }));
    expect(preview.kind).toBe("invalid");
    if (preview.kind === "invalid") expect(preview.issues[0]?.code).toBe("OVER_REFUND");
  });

  it("refunds the whole sale exactly, rounding included, and says it completes the sale", () => {
    let choices = {};
    for (const line of sale.lines) choices = withAll(choices, line, progress.get(line.id)!);
    const preview = previewRefund(
      input({ draft: { ...EMPTY_DRAFT, reason: "CHANGED_MIND", choices } }),
    );
    expect(preview.kind === "ok" && preview.plan.totalAmount).toBe(sale.totalAmount);
    expect(preview.kind === "ok" && preview.plan.completesSale).toBe(true);
    expect(preview.kind === "ok" && preview.plan.cashRefund).toBe(850_200n);
  });

  it("subtracts earlier refunds from what can still be returned", () => {
    const partly = makeSale({
      refunds: [
        {
          id: IDS.refund,
          number: "UB1-R-000001",
          occurredAt: "2026-10-14T12:00:00.000Z",
          reason: "DEFECTIVE",
          totalAmount: 500_000n,
          tipAmount: 0n,
          lines: [
            {
              saleLineId: milk.id,
              qtyMilli: 1000,
              restock: true,
              netAmount: 454_545n,
              vatAmount: 45_455n,
              cityTaxAmount: 0n,
              totalAmount: 500_000n,
            },
          ],
          payments: [{ method: "CARD", amount: 500_000n, originalPaymentId: IDS.card }],
        },
      ],
    });
    expect(saleState(partly)).toBe("PARTIALLY_REFUNDED");
    const remaining = progressOf(partly).get(milk.id)!;
    expect(remaining.remainingQtyMilli).toBe(1000);
    const preview = previewRefund(
      input({
        sale: partly,
        draft: {
          ...EMPTY_DRAFT,
          reason: "DEFECTIVE",
          choices: { [milk.id]: { qtyMilli: 2000, restock: true } },
        },
      }),
    );
    expect(preview.kind).toBe("invalid");
  });

  it("never throws on rows that contradict each other", () => {
    const broken = makeSale({ payments: [] });
    const preview = previewRefund(
      input({
        sale: broken,
        draft: {
          ...EMPTY_DRAFT,
          reason: "DEFECTIVE",
          choices: { [milk.id]: { qtyMilli: 1000, restock: true } },
        },
      }),
    );
    expect(preview.kind).toBe("invalid");
  });
});

describe("blockers and approvals", () => {
  const base: Draft = {
    ...EMPTY_DRAFT,
    choices: { [milk.id]: { qtyMilli: 1000, restock: true } },
  };

  it("needs a reason, and a note for OTHER, without hiding the numbers", () => {
    expect(blockersOf(base)).toEqual(["REASON"]);
    expect(blockersOf({ ...base, reason: "OTHER" })).toEqual(["NOTE"]);
    expect(blockersOf({ ...base, reason: "OTHER", note: "  x " })).toEqual([]);
    const preview = previewRefund(input({ draft: { ...base, reason: "OTHER" } }));
    expect(preview.kind).toBe("ok");
    if (preview.kind === "ok") {
      expect(preview.blockers).toEqual(["NOTE"]);
      expect(preview.plan.totalAmount).toBe(500_000n);
    }
  });

  it("a cashier needs the refund approval, a manager does not", () => {
    const draft = { ...base, reason: "DEFECTIVE" as const };
    const cashier = previewRefund(input({ draft, role: "CASHIER" }));
    const manager = previewRefund(input({ draft, role: "MANAGER" }));
    expect(cashier.kind === "ok" && cashier.needed.map((r) => r.key)).toEqual(["refund"]);
    expect(manager.kind === "ok" && manager.needed).toEqual([]);
  });

  it("approvals are bound to the exact amount: a change drops the token", () => {
    const draft = { ...base, reason: "DEFECTIVE" as const };
    const first = previewRefund(input({ draft }));
    if (first.kind !== "ok") throw new Error("expected ok");
    const requirement = first.needed[0]!;
    expect(requirement.scope).toContain(IDS.newRefund);
    const held = {
      refund: { token: "tok", scope: requirement.scope, approverName: "Сарантуяа" },
    };
    expect(missingApprovals(first.needed, held)).toEqual([]);
    expect(approvalTokensFor(first.requirements, held)).toEqual({ refund: "tok" });

    const changed = previewRefund(
      input({
        draft: { ...draft, choices: { [milk.id]: { qtyMilli: 2000, restock: true } } },
      }),
    );
    if (changed.kind !== "ok") throw new Error("expected ok");
    expect(missingApprovals(changed.needed, held).map((r) => r.key)).toEqual(["refund"]);
    expect(approvalTokensFor(changed.requirements, held)).toEqual({});
  });

  it("flags the window and asks for the window approval", () => {
    const draft = { ...base, reason: "DEFECTIVE" as const };
    const preview = previewRefund(
      input({
        draft,
        sale: makeSale({ occurredAt: "2026-08-01T00:00:00.000Z" }),
        maxRefundWindowDays: 30,
      }),
    );
    if (preview.kind !== "ok") throw new Error("expected ok");
    expect(preview.outsideWindow).toBe(true);
    expect(preview.requirements.map((r) => r.key)).toContain("refund:window");
    expect(preview.needed.map((r) => r.key)).toContain("refund:window");
    expect(saleAgeDays(makeSale({ occurredAt: "2026-08-01T00:00:00.000Z" }), NOW)).toBe(75);
    const inside = previewRefund(input({ draft, maxRefundWindowDays: 30 }));
    expect(inside.kind === "ok" && inside.outsideWindow).toBe(false);
  });
});

describe("payout choice", () => {
  const draft: Draft = {
    ...EMPTY_DRAFT,
    reason: "DEFECTIVE",
    choices: { [milk.id]: { qtyMilli: 2000, restock: true } },
  };

  it("defaults to the original tenders proportionally", () => {
    const preview = previewRefund(input({ draft }));
    if (preview.kind !== "ok") throw new Error("expected ok");
    const rows = payoutRows(preview.plan);
    expect(rows.reduce((a, r) => a + r.amount, 0n)).toBe(preview.plan.totalAmount);
    expect(rows.map((r) => r.method).sort()).toEqual(["CARD", "CASH"]);
    expect(preview.plan.needs.methodOverride).toBe(false);
  });

  it("all-cash is cross-method and needs the method approval from a cashier", () => {
    const preview = previewRefund(
      input({ draft: { ...draft, payout: { kind: "METHOD", method: "CASH" } } }),
    );
    if (preview.kind !== "ok") throw new Error("expected ok");
    expect(preview.plan.cashRefund).toBe(preview.plan.totalAmount);
    expect(preview.requirements.map((r) => r.key)).toContain("refund:method");
    expect(preview.needed.map((r) => r.key)).toEqual(["refund", "refund:method"]);
    const manager = previewRefund(
      input({ draft: { ...draft, payout: { kind: "METHOD", method: "CASH" } }, role: "MANAGER" }),
    );
    expect(manager.kind === "ok" && manager.needed).toEqual([]);
  });

  it("a custom split that does not add up is a planner issue", () => {
    const preview = previewRefund(
      input({
        draft: {
          ...draft,
          payout: { kind: "CUSTOM", entries: [{ method: "CARD", amount: 100n }] },
        },
      }),
    );
    expect(preview.kind).toBe("invalid");
    if (preview.kind === "invalid") expect(preview.issues[0]?.code).toBe("PAYMENT_MISMATCH");
  });

  it("card cannot be paid out beyond what card paid", () => {
    const preview = previewRefund(
      input({
        draft: {
          ...draft,
          choices: {
            [milk.id]: { qtyMilli: 2000, restock: true },
            [apples.id]: { qtyMilli: 1500, restock: true },
          },
          payout: { kind: "METHOD", method: "CARD" },
        },
      }),
    );
    expect(preview.kind).toBe("invalid");
    if (preview.kind === "invalid")
      expect(preview.issues[0]?.code).toBe("REFUND_METHOD_NOT_ALLOWED");
  });
});

describe("exchange", () => {
  const draft: Draft = {
    ...EMPTY_DRAFT,
    reason: "WRONG_ITEM",
    choices: { [milk.id]: { qtyMilli: 2000, restock: true } },
  };

  it("credit = min(refund, replacement); net due or net refund follows", () => {
    const dearer = previewRefund(input({ draft, exchangeTotal: 1_500_000n }));
    if (dearer.kind !== "ok") throw new Error("expected ok");
    expect(dearer.plan.exchange).toMatchObject({
      creditApplied: 1_000_000n,
      netDue: 500_000n,
      netRefund: 0n,
    });
    const cheaper = previewRefund(input({ draft, exchangeTotal: 400_000n }));
    if (cheaper.kind !== "ok") throw new Error("expected ok");
    expect(cheaper.plan.exchange).toMatchObject({
      creditApplied: 400_000n,
      netDue: 0n,
      netRefund: 600_000n,
    });
    // the payout covers only the net refund
    expect(payoutRows(cheaper.plan).reduce((a, r) => a + r.amount, 0n)).toBe(600_000n);
  });
});

describe("buildRefundInput", () => {
  it("produces a request the server's schema accepts, pinning the previewed total", () => {
    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "OTHER",
      note: "  Тайлбар  ",
      choices: { [milk.id]: { qtyMilli: 1000, restock: true } },
    };
    const preview = previewRefund(input({ draft }));
    if (preview.kind !== "ok") throw new Error("expected ok");
    const wire = buildRefundInput({
      refundId: IDS.newRefund,
      sale,
      draft,
      plan: preview.plan,
      approvals: { refund: "token" },
      now: NOW,
    });
    expect(wire.expectedTotal).toBe(preview.plan.totalAmount.toString());
    expect(wire.payments).toBeUndefined();
    expect(wire.note).toBe("Тайлбар");
    const parsed = refundRequestSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.refundId).toBe(IDS.newRefund);
      expect(parsed.data.lines).toEqual([{ saleLineId: milk.id, qtyMilli: 1000, restock: true }]);
      expect(parsed.data.expectedTotal).toBe(preview.plan.totalAmount);
    }
  });

  it("sends the payout override rows and the exchange reference", () => {
    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "WRONG_ITEM",
      choices: { [milk.id]: { qtyMilli: 2000, restock: true } },
      payout: { kind: "METHOD", method: "CASH" },
    };
    const preview = previewRefund(input({ draft, exchangeTotal: 400_000n }));
    if (preview.kind !== "ok") throw new Error("expected ok");
    const wire = buildRefundInput({
      refundId: IDS.newRefund,
      sale,
      draft,
      plan: preview.plan,
      approvals: {},
      exchange: { saleId: IDS.exchangeSale, expectedPayable: 400_000n },
      now: NOW,
    });
    expect(wire.payments).toEqual([{ method: "CASH", amount: "600000" }]);
    expect(wire.exchange).toEqual({ saleId: IDS.exchangeSale, expectedPayable: "400000" });
    expect(refundRequestSchema.safeParse(wire).success).toBe(true);
  });
});
