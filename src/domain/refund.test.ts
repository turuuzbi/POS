import { describe, expect, it } from "vitest";
import { extend } from "./qty";
import { fromMajor, sum, type Money } from "./money";
import { roundTotal } from "./rounding";
import { computeLineTax } from "./tax";
import {
  allocateAcrossSources,
  isFullyRefunded,
  lineProgress,
  paymentCapacities,
  planRefund,
  refundShare,
  type PaymentMethod,
  type PreviousRefund,
  type RefundContext,
  type RefundPlan,
  type RefundRequest,
  type RefundSaleLine,
  type RefundSaleSnapshot,
} from "./refund";

const T = fromMajor;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const NOW = new Date("2026-10-15T12:00:00Z");

function line(
  id: string,
  qtyMilli: number,
  total: Money,
  parts: { vat?: Money; city?: Money } = {},
  extra: Partial<RefundSaleLine> = {},
): RefundSaleLine {
  const vat = parts.vat ?? 0n;
  const city = parts.city ?? 0n;
  return {
    id,
    variantId: `v-${id}`,
    unit: qtyMilli % 1000 === 0 ? "PIECE" : "KG",
    qtyMilli,
    totalAmount: total,
    netAmount: total - vat - city,
    vatAmount: vat,
    cityTaxAmount: city,
    unitCost: T(400),
    ...extra,
  };
}

function snapshot(
  lines: RefundSaleLine[],
  payments: { id: string; method: PaymentMethod; amount: Money }[],
  extra: Partial<RefundSaleSnapshot> = {},
): RefundSaleSnapshot {
  const total = sum(lines.map((l) => l.totalAmount));
  return {
    id: "sale-1",
    status: "COMPLETED",
    occurredAt: new Date("2026-10-14T09:00:00Z"),
    shiftId: "shift-1",
    totalAmount: total,
    tipAmount: 0n,
    roundingAmount: 0n,
    lines,
    payments,
    ...extra,
  };
}

const ctx = (extra: Partial<RefundContext> = {}): RefundContext => ({
  shiftOpen: true,
  now: NOW,
  roundingUnit: 100n,
  grants: { refund: true, methodOverride: true, outsideWindow: true },
  ...extra,
});

const req = (
  lines: { id: string; qty: number; restock?: boolean }[],
  extra: Partial<RefundRequest> = {},
): RefundRequest => ({
  lines: lines.map((l) => ({
    saleLineId: l.id,
    qtyMilli: l.qty,
    restock: l.restock ?? true,
  })),
  reason: "CHANGED_MIND",
  ...extra,
});

function asPrevious(plan: RefundPlan, id: string): PreviousRefund {
  return {
    id,
    totalAmount: plan.totalAmount,
    tipAmount: plan.tipAmount,
    lines: plan.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      totalAmount: l.totalAmount,
    })),
    payments: plan.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      originalPaymentId: p.originalPaymentId,
    })),
  };
}

function mustPlan(
  sale: RefundSaleSnapshot,
  prev: PreviousRefund[],
  request: RefundRequest,
  context = ctx(),
): RefundPlan {
  const r = planRefund(sale, prev, request, context);
  if (!r.ok) throw new Error(`plan failed: ${JSON.stringify(r.issues)}`);
  return r.plan;
}

// ---------------------------------------------------------------------------

describe("refundShare: exact pro-rata with the last-unit rule", () => {
  it("refunding 1 of 3 pieces of 100₮ splits 33.33 / 33.33 / 33.34", () => {
    const l = line("a", 3000, 10_000n, { vat: 909n });
    const sale = snapshot([l], [{ id: "p", method: "CASH", amount: 10_000n }]);
    let prev: PreviousRefund[] = [];
    const got: Money[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = mustPlan(sale, prev, req([{ id: "a", qty: 1000 }]), ctx({ roundingUnit: 1n }));
      got.push(plan.lines[0]!.totalAmount);
      prev = [...prev, asPrevious(plan, `r${i}`)];
    }
    expect(got).toEqual([3333n, 3334n, 3333n]);
    expect(sum(got)).toBe(10_000n);
  });

  it("rejects out-of-range quantities", () => {
    const l = line("a", 2000, 1000n);
    const [p] = lineProgress({ lines: [l] }, []);
    expect(() => refundShare(l, p!, 0)).toThrow(RangeError);
    expect(() => refundShare(l, p!, 2001)).toThrow(RangeError);
  });

  it("seeded: any partition in any order sums EXACTLY to the line; parts stay consistent", () => {
    const r = rng(2026);
    for (let n = 0; n < 4000; n++) {
      const qtyMilli = r() < 0.5 ? int(r, 1, 12) * 1000 : int(r, 2, 20_000);
      const total = BigInt(int(r, 0, 5_000_000));
      const vat = BigInt(Math.floor(r() * Number(total) * 0.1));
      const city = BigInt(Math.floor(r() * Number(total - vat) * 0.05));
      const l = line("x", qtyMilli, total, { vat, city });
      const unitStep = qtyMilli % 1000 === 0 ? 1000 : 1;
      // random partition into pieces
      const pieces: number[] = [];
      let left = qtyMilli;
      while (left > 0) {
        const take = Math.min(left, unitStep * int(r, 1, Math.max(1, Math.ceil(left / unitStep))));
        pieces.push(take);
        left -= take;
      }
      // random order
      for (let i = pieces.length - 1; i > 0; i--) {
        const j = int(r, 0, i);
        [pieces[i], pieces[j]] = [pieces[j]!, pieces[i]!];
      }
      const done = { net: 0n, vat: 0n, city: 0n, total: 0n };
      let prevRefunds: PreviousRefund[] = [];
      for (const [i, q] of pieces.entries()) {
        const [prog] = lineProgress({ lines: [l] }, prevRefunds);
        const share = refundShare(l, prog!, q);
        expect(share.net + share.vat + share.city).toBe(share.total);
        expect(share.net >= 0n && share.vat >= 0n && share.city >= 0n).toBe(true);
        done.net += share.net;
        done.vat += share.vat;
        done.city += share.city;
        done.total += share.total;
        expect(done.total <= l.totalAmount).toBe(true);
        prevRefunds = [
          ...prevRefunds,
          {
            id: String(i),
            totalAmount: share.total,
            tipAmount: 0n,
            lines: [
              {
                saleLineId: "x",
                qtyMilli: q,
                netAmount: share.net,
                vatAmount: share.vat,
                cityTaxAmount: share.city,
                totalAmount: share.total,
              },
            ],
            payments: [],
          },
        ];
      }
      expect(done).toEqual({
        net: l.netAmount,
        vat: l.vatAmount,
        city: l.cityTaxAmount,
        total: l.totalAmount,
      });
    }
  });

  it("seeded: cumulative amount after the same set of quantities is order independent", () => {
    const r = rng(9);
    for (let n = 0; n < 500; n++) {
      const l = line("x", 7000, BigInt(int(r, 1, 100_000)), {});
      const forward = [1000, 2000, 1000];
      const backward = [1000, 2000, 1000].reverse();
      const run = (order: number[]) => {
        let prev: PreviousRefund[] = [];
        let totalDone = 0n;
        for (const q of order) {
          const [prog] = lineProgress({ lines: [l] }, prev);
          const s = refundShare(l, prog!, q);
          totalDone += s.total;
          prev = [
            ...prev,
            {
              id: String(prev.length),
              totalAmount: s.total,
              tipAmount: 0n,
              lines: [
                {
                  saleLineId: "x",
                  qtyMilli: q,
                  netAmount: s.net,
                  vatAmount: s.vat,
                  cityTaxAmount: s.city,
                  totalAmount: s.total,
                },
              ],
              payments: [],
            },
          ];
        }
        return totalDone;
      };
      expect(run(forward)).toBe(run(backward));
      expect(run([4000])).toBe(run([1000, 3000]));
    }
  });

  it("handles a pathological line (zero net, all tax)", () => {
    const l = line("x", 2000, 2n, { vat: 1n, city: 1n });
    const sale = snapshot([l], [{ id: "p", method: "CASH", amount: 2n }]);
    const p1 = mustPlan(sale, [], req([{ id: "x", qty: 1000 }]), ctx({ roundingUnit: 1n }));
    const p2 = mustPlan(
      sale,
      [asPrevious(p1, "r1")],
      req([{ id: "x", qty: 1000 }]),
      ctx({ roundingUnit: 1n }),
    );
    expect(p1.lines[0]!.totalAmount + p2.lines[0]!.totalAmount).toBe(2n);
    expect(p1.vatAmount + p2.vatAmount).toBe(1n);
    expect(p1.cityTaxAmount + p2.cityTaxAmount).toBe(1n);
  });
});

describe("planRefund: quantities and lines", () => {
  const sale = snapshot(
    [
      line("a", 3000, T(30_000), { vat: T(2727) }),
      line("w", 1250, T(12_500), { vat: 113_636n }, { unitCost: T(6000) }),
    ],
    [{ id: "p1", method: "CASH", amount: T(42_500) }],
  );

  it("refunds whole pieces and partial weights", () => {
    const plan = mustPlan(
      sale,
      [],
      req([
        { id: "a", qty: 1000 },
        { id: "w", qty: 500 },
      ]),
    );
    expect(plan.lines.map((l) => l.qtyMilli)).toEqual([1000, 500]);
    expect(plan.lines[1]!.totalAmount).toBe(T(5000));
    expect(plan.itemsTotal).toBe(T(10_000) + T(5000));
    expect(plan.completesSale).toBe(false);
  });

  it("piece items cannot be refunded by fraction", () => {
    const r = planRefund(sale, [], req([{ id: "a", qty: 500 }]), ctx());
    expect(r).toMatchObject({ ok: false, issues: [{ code: "INVALID_QUANTITY", saleLineId: "a" }] });
  });

  it("over-refund and already-refunded are reported", () => {
    const first = mustPlan(sale, [], req([{ id: "a", qty: 2000 }]));
    const prev = [asPrevious(first, "r1")];
    const over = planRefund(sale, prev, req([{ id: "a", qty: 2000 }]), ctx());
    expect(over).toMatchObject({ ok: false, issues: [{ code: "OVER_REFUND" }] });
    const second = mustPlan(sale, prev, req([{ id: "a", qty: 1000 }]));
    const done = planRefund(
      sale,
      [...prev, asPrevious(second, "r2")],
      req([{ id: "a", qty: 1000 }]),
      ctx(),
    );
    expect(done).toMatchObject({ ok: false, issues: [{ code: "ALREADY_REFUNDED" }] });
  });

  it("flags duplicates, unknown lines, empty requests, closed shift, voided sale", () => {
    const codes = (r: ReturnType<typeof planRefund>) => (r.ok ? [] : r.issues.map((i) => i.code));
    expect(
      codes(
        planRefund(
          sale,
          [],
          req([
            { id: "a", qty: 1000 },
            { id: "a", qty: 1000 },
          ]),
          ctx(),
        ),
      ),
    ).toContain("DUPLICATE_LINE");
    expect(codes(planRefund(sale, [], req([{ id: "zz", qty: 1000 }]), ctx()))).toContain(
      "UNKNOWN_LINE",
    );
    expect(codes(planRefund(sale, [], req([]), ctx()))).toContain("NO_LINES");
    expect(
      codes(planRefund(sale, [], req([{ id: "a", qty: 1000 }]), ctx({ shiftOpen: false }))),
    ).toContain("SHIFT_NOT_OPEN");
    expect(
      codes(planRefund({ ...sale, status: "VOIDED" }, [], req([{ id: "a", qty: 1000 }]), ctx())),
    ).toContain("SALE_NOT_COMPLETED");
    expect(codes(planRefund(sale, [], req([{ id: "a", qty: -1000 }]), ctx()))).toContain(
      "INVALID_QUANTITY",
    );
  });

  it("reason OTHER needs a note", () => {
    const r = planRefund(sale, [], { ...req([{ id: "a", qty: 1000 }]), reason: "OTHER" }, ctx());
    expect(r.ok === false && r.issues.map((i) => i.code)).toContain("REASON_NOTE_REQUIRED");
    expect(
      planRefund(sale, [], { ...req([{ id: "a", qty: 1000 }]), reason: "OTHER", note: "x" }, ctx())
        .ok,
    ).toBe(true);
  });

  it("a sold gift card line is NOT_SUPPORTED", () => {
    const s = snapshot(
      [line("g", 1000, T(50_000), {}, { isGiftCard: true })],
      [{ id: "p", method: "CASH", amount: T(50_000) }],
    );
    const r = planRefund(s, [], req([{ id: "g", qty: 1000 }]), ctx());
    expect(r).toMatchObject({ ok: false, issues: [{ code: "NOT_SUPPORTED", saleLineId: "g" }] });
  });

  it("isFullyRefunded", () => {
    const all = mustPlan(
      sale,
      [],
      req([
        { id: "a", qty: 3000 },
        { id: "w", qty: 1250 },
      ]),
    );
    expect(all.completesSale).toBe(true);
    expect(isFullyRefunded(sale, [])).toBe(false);
    expect(isFullyRefunded(sale, [asPrevious(all, "r")])).toBe(true);
  });
});

describe("planRefund: stock and COGS", () => {
  const sale = snapshot(
    [
      line("a", 2000, T(20_000), {}, { unitCost: T(3000) }),
      line("s", 1000, T(5000), {}, { tracksStock: false, unitCost: 0n }),
      line("w", 1500, T(9000), {}, { unitCost: T(2000) }),
    ],
    [{ id: "p", method: "CASH", amount: T(34_000) }],
  );

  it("restock yes: stock plan and COGS reversal at the original snapshot", () => {
    const plan = mustPlan(
      sale,
      [],
      req([
        { id: "a", qty: 1000, restock: true },
        { id: "w", qty: 500, restock: true },
      ]),
    );
    expect(plan.stockRestores).toEqual([
      { saleLineId: "a", variantId: "v-a", qtyMilli: 1000, unitCost: T(3000) },
      { saleLineId: "w", variantId: "v-w", qtyMilli: 500, unitCost: T(2000) },
    ]);
    expect(plan.lines[0]!.cogsReversal).toBe(T(3000));
    expect(plan.lines[1]!.cogsReversal).toBe(extend(T(2000), 500));
    expect(plan.cogsReversalTotal).toBe(T(3000) + T(1000));
  });

  it("restock no: no stock movement and no COGS reversal", () => {
    const plan = mustPlan(sale, [], req([{ id: "a", qty: 1000, restock: false }]));
    expect(plan.stockRestores).toEqual([]);
    expect(plan.lines[0]!.restock).toBe(false);
    expect(plan.cogsReversalTotal).toBe(0n);
  });

  it("services are never restocked, even if asked", () => {
    const plan = mustPlan(sale, [], req([{ id: "s", qty: 1000, restock: true }]));
    expect(plan.lines[0]!.restock).toBe(false);
    expect(plan.stockRestores).toEqual([]);
  });
});

describe("planRefund: totals, rounding and the final refund", () => {
  it("rounds to the unit with a signed roundingAmount", () => {
    const s = snapshot(
      [line("a", 2000, 10_300n), line("b", 1000, 10_000n)],
      [{ id: "p", method: "CARD", amount: 20_300n }],
      { totalAmount: 20_300n },
    );
    const up = mustPlan(s, [], req([{ id: "a", qty: 1000 }]), ctx({ roundingUnit: 500n }));
    expect(up.itemsTotal).toBe(5150n);
    expect(up.totalAmount).toBe(5000n);
    expect(up.roundingAmount).toBe(-150n);
    const half = mustPlan(
      snapshot([line("a", 1000, 5250n)], [{ id: "p", method: "CARD", amount: 5500n }], {
        totalAmount: 5500n,
      }),
      [],
      req([{ id: "a", qty: 1000 }]),
      ctx({ roundingUnit: 500n }),
    );
    expect(half.totalAmount).toBe(5500n); // the final refund takes everything still held
    expect(half.roundingAmount).toBe(250n);
  });

  it("the completing refund returns the remaining tip and rounding exactly", () => {
    const s = snapshot(
      [line("a", 1000, 10_450n)],
      [
        { id: "p1", method: "CASH", amount: 7000n },
        { id: "p2", method: "CARD", amount: 4000n },
      ],
      { tipAmount: 500n, roundingAmount: 50n, totalAmount: 11_000n },
    );
    const plan = mustPlan(s, [], req([{ id: "a", qty: 1000 }]), ctx({ roundingUnit: 100n }));
    expect(plan.completesSale).toBe(true);
    expect(plan.tipAmount).toBe(500n);
    expect(plan.roundingAmount).toBe(50n);
    expect(plan.totalAmount).toBe(11_000n);
    expect(sum(plan.payments.map((p) => p.amount))).toBe(11_000n);
  });

  it("never refunds more than was paid across a run of roundings", () => {
    const s = snapshot(
      [line("a", 1000, 300n), line("b", 1000, 300n), line("c", 1000, 300n)],
      [{ id: "p", method: "CARD", amount: 1000n }],
      { totalAmount: 1000n },
    );
    let prev: PreviousRefund[] = [];
    let total = 0n;
    for (const id of ["a", "b", "c"]) {
      const plan = mustPlan(s, prev, req([{ id, qty: 1000 }]), ctx({ roundingUnit: 500n }));
      total += plan.totalAmount;
      prev = [...prev, asPrevious(plan, id)];
    }
    expect(total).toBe(1000n);
  });
});

describe("planRefund: payment allocation", () => {
  const split = snapshot(
    [line("a", 1000, T(30_000))],
    [
      { id: "cash", method: "CASH", amount: T(10_000) },
      { id: "card", method: "CARD", amount: T(20_000) },
    ],
  );

  it("defaults to the original methods, proportionally", () => {
    const plan = mustPlan(split, [], req([{ id: "a", qty: 1000 }]));
    expect(plan.payments).toEqual([
      { method: "CASH", amount: T(10_000), originalPaymentId: "cash", crossMethod: false },
      { method: "CARD", amount: T(20_000), originalPaymentId: "card", crossMethod: false },
    ]);
    expect(plan.cashRefund).toBe(T(10_000));
  });

  it("a partial refund is split in proportion", () => {
    const s = snapshot(
      [line("a", 3000, T(30_000))],
      [
        { id: "cash", method: "CASH", amount: T(10_000) },
        { id: "card", method: "CARD", amount: T(20_000) },
      ],
    );
    const plan = mustPlan(s, [], req([{ id: "a", qty: 1000 }]));
    expect(plan.payments.map((p) => [p.method, p.amount])).toEqual([
      ["CASH", 333_333n - (333_333n % 100n)],
      ["CARD", T(10_000) - (333_333n - (333_333n % 100n))],
    ]);
  });

  it("LIFO refunds the newest tender first", () => {
    const s = snapshot(
      [line("a", 3000, T(30_000))],
      [
        { id: "cash", method: "CASH", amount: T(10_000) },
        { id: "card", method: "CARD", amount: T(20_000) },
      ],
    );
    const plan = mustPlan(s, [], req([{ id: "a", qty: 1000 }]), ctx({ strategy: "LIFO" }));
    expect(plan.payments).toEqual([
      { method: "CARD", amount: T(10_000), originalPaymentId: "card", crossMethod: false },
    ]);
  });

  it("cash is capped at what the till kept (change already excluded)", () => {
    // customer handed over 20 000₮ for a 12 000₮ sale: the cash payment row is 12 000₮.
    const s = snapshot(
      [line("a", 1000, T(12_000))],
      [{ id: "c", method: "CASH", amount: T(12_000) }],
    );
    const plan = mustPlan(s, [], req([{ id: "a", qty: 1000 }]));
    expect(plan.cashRefund).toBe(T(12_000));
    const again = planRefund(s, [asPrevious(plan, "r")], req([{ id: "a", qty: 1000 }]), ctx());
    expect(again.ok).toBe(false);
  });

  it("earlier refunds reduce what each tender can still give back", () => {
    const s = snapshot(
      [line("a", 2000, T(20_000)), line("b", 1000, T(10_000))],
      [
        { id: "cash", method: "CASH", amount: T(10_000) },
        { id: "card", method: "CARD", amount: T(20_000) },
      ],
    );
    const first = mustPlan(s, [], req([{ id: "a", qty: 2000 }]), ctx({ strategy: "LIFO" }));
    expect(first.payments).toEqual([
      { method: "CARD", amount: T(20_000), originalPaymentId: "card", crossMethod: false },
    ]);
    const caps = paymentCapacities(s, [asPrevious(first, "r1")]);
    expect(caps.map((c) => c.remaining)).toEqual([T(10_000), 0n]);
    const second = mustPlan(s, [asPrevious(first, "r1")], req([{ id: "b", qty: 1000 }]));
    expect(second.payments).toEqual([
      { method: "CASH", amount: T(10_000), originalPaymentId: "cash", crossMethod: false },
    ]);
  });

  it("gift card / store credit tenders are NOT_SUPPORTED stubs", () => {
    const s = snapshot(
      [line("a", 1000, T(30_000))],
      [
        { id: "g", method: "GIFT_CARD", amount: T(10_000) },
        { id: "c", method: "CASH", amount: T(20_000) },
      ],
    );
    const r = planRefund(s, [], req([{ id: "a", qty: 1000 }]), ctx());
    expect(r).toMatchObject({ ok: false, issues: [{ code: "NOT_SUPPORTED" }] });
    // refunding only what the supported tender can carry works
    const s2 = snapshot(
      [line("a", 3000, T(30_000))],
      [
        { id: "g", method: "GIFT_CARD", amount: T(10_000) },
        { id: "c", method: "CASH", amount: T(20_000) },
      ],
    );
    expect(planRefund(s2, [], req([{ id: "a", qty: 2000 }]), ctx()).ok).toBe(true);
  });

  it("manager override: another split within the original tenders needs no cross-method approval", () => {
    const s = snapshot(
      [line("a", 3000, T(30_000))],
      [
        { id: "cash", method: "CASH", amount: T(10_000) },
        { id: "card", method: "CARD", amount: T(20_000) },
      ],
    );
    const plan = mustPlan(
      s,
      [],
      req([{ id: "a", qty: 1000 }], { paymentOverride: [{ method: "CARD", amount: T(10_000) }] }),
      ctx({ grants: { refund: true, methodOverride: false, outsideWindow: false } }),
    );
    expect(plan.needs.methodOverride).toBe(false);
  });

  it("override to cash for a card payment needs the approval flag", () => {
    const s = snapshot(
      [line("a", 1000, T(20_000))],
      [{ id: "card", method: "CARD", amount: T(20_000) }],
    );
    const request = req([{ id: "a", qty: 1000 }], {
      paymentOverride: [{ method: "CASH", amount: T(20_000) }],
    });
    const denied = planRefund(
      s,
      [],
      request,
      ctx({ grants: { refund: true, methodOverride: false, outsideWindow: false } }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.issues).toEqual([
        { code: "APPROVAL_REQUIRED", details: { needs: ["methodOverride"] } },
      ]);
      expect(denied.preview?.needs.methodOverride).toBe(true);
    }
    const allowed = mustPlan(s, [], request);
    expect(allowed.payments).toEqual([
      { method: "CASH", amount: T(20_000), originalPaymentId: "card", crossMethod: true },
    ]);
    // the card payment is used up: it cannot be refunded again
    expect(paymentCapacities(s, [asPrevious(allowed, "r")])[0]!.remaining).toBe(0n);
  });

  it("card / QPay can never be refunded beyond what that method paid, approval or not", () => {
    const s = snapshot(
      [line("a", 1000, T(30_000))],
      [
        { id: "cash", method: "CASH", amount: T(10_000) },
        { id: "card", method: "CARD", amount: T(20_000) },
      ],
    );
    const r = planRefund(
      s,
      [],
      req([{ id: "a", qty: 1000 }], { paymentOverride: [{ method: "CARD", amount: T(30_000) }] }),
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, issues: [{ code: "REFUND_METHOD_NOT_ALLOWED" }] });
    const noQpay = planRefund(
      s,
      [],
      req([{ id: "a", qty: 1000 }], { paymentOverride: [{ method: "QPAY", amount: T(30_000) }] }),
      ctx(),
    );
    expect(noQpay).toMatchObject({ ok: false, issues: [{ code: "REFUND_METHOD_NOT_ALLOWED" }] });
  });

  it("override sums must match, cash in whole units, no stub methods", () => {
    const s = snapshot(
      [line("a", 1000, T(20_000))],
      [{ id: "cash", method: "CASH", amount: T(20_000) }],
    );
    const codes = (o: { method: PaymentMethod; amount: Money }[]) => {
      const r = planRefund(s, [], req([{ id: "a", qty: 1000 }], { paymentOverride: o }), ctx());
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes([{ method: "CASH", amount: T(19_000) }])).toEqual(["PAYMENT_MISMATCH"]);
    expect(
      codes([
        { method: "CASH", amount: 1_999_950n },
        { method: "CASH", amount: 50n },
      ]),
    ).toContain("CASH_NOT_IN_UNITS");
    expect(codes([{ method: "GIFT_CARD", amount: T(20_000) }])).toEqual(["NOT_SUPPORTED"]);
    expect(
      codes([
        { method: "CASH", amount: 0n },
        { method: "CASH", amount: T(20_000) },
      ]),
    ).toEqual(["PAYMENT_MISMATCH"]);
  });

  it("an unsupported original tender can be paid out as cash with approval", () => {
    const s = snapshot(
      [line("a", 1000, T(30_000))],
      [
        { id: "g", method: "GIFT_CARD", amount: T(10_000) },
        { id: "c", method: "CASH", amount: T(20_000) },
      ],
    );
    const plan = mustPlan(
      s,
      [],
      req([{ id: "a", qty: 1000 }], { paymentOverride: [{ method: "CASH", amount: T(30_000) }] }),
    );
    expect(plan.needs.methodOverride).toBe(true);
    expect(plan.payments.map((p) => [p.originalPaymentId, p.amount, p.crossMethod])).toEqual([
      ["c", T(20_000), false],
      ["g", T(10_000), true],
    ]);
  });
});

describe("allocateAcrossSources", () => {
  it("returns null when caps are short", () => {
    expect(
      allocateAcrossSources(10n, [{ id: "a", method: "CARD", cap: 9n }], "LIFO", 1n),
    ).toBeNull();
  });
  it("seeded: sums exactly, honours caps and the cash unit", () => {
    const r = rng(4242);
    for (let n = 0; n < 2000; n++) {
      const count = int(r, 1, 4);
      const methods = ["CASH", "CARD", "QPAY", "BANK_TRANSFER"] as const;
      const sources = Array.from({ length: count }, (_, i) => ({
        id: String(i),
        method: methods[int(r, 0, 3)]!,
        cap: BigInt(int(r, 0, 5000)) * 100n,
      }));
      const capSum = sum(sources.map((s) => s.cap));
      const amount = BigInt(int(r, 0, Number(capSum / 100n))) * 100n;
      for (const strategy of ["PROPORTIONAL", "LIFO"] as const) {
        const parts = allocateAcrossSources(amount, sources, strategy, 100n);
        expect(parts).not.toBeNull();
        if (!parts) continue;
        expect(sum(parts)).toBe(amount);
        parts.forEach((p, i) => {
          expect(p >= 0n && p <= sources[i]!.cap).toBe(true);
          if (sources[i]!.method === "CASH") expect(p % 100n).toBe(0n);
        });
      }
    }
  });
});

describe("planRefund: exchange", () => {
  const sale = snapshot(
    [line("a", 2000, T(40_000))],
    [
      { id: "cash", method: "CASH", amount: T(10_000) },
      { id: "card", method: "CARD", amount: T(30_000) },
    ],
  );

  it("new item costs more: credit covers the refund, the difference is due", () => {
    const plan = mustPlan(
      sale,
      [],
      req([{ id: "a", qty: 1000 }], { exchangeSaleTotal: T(35_000) }),
    );
    expect(plan.totalAmount).toBe(T(20_000));
    expect(plan.exchange).toEqual({
      newSaleTotal: T(35_000),
      creditApplied: T(20_000),
      netDue: T(15_000),
      netRefund: 0n,
    });
    expect(plan.payments.every((p) => p.method === "EXCHANGE_CREDIT")).toBe(true);
    expect(sum(plan.payments.map((p) => p.amount))).toBe(T(20_000));
    expect(plan.cashRefund).toBe(0n);
  });

  it("new item costs less: the rest is refunded to the original tenders", () => {
    const plan = mustPlan(sale, [], req([{ id: "a", qty: 1000 }], { exchangeSaleTotal: T(8000) }));
    expect(plan.exchange).toMatchObject({
      creditApplied: T(8000),
      netDue: 0n,
      netRefund: T(12_000),
    });
    const real = plan.payments.filter((p) => p.method !== "EXCHANGE_CREDIT");
    expect(sum(real.map((p) => p.amount))).toBe(T(12_000));
    expect(sum(plan.payments.map((p) => p.amount))).toBe(T(20_000));
  });

  it("even exchange", () => {
    const plan = mustPlan(
      sale,
      [],
      req([{ id: "a", qty: 1000 }], { exchangeSaleTotal: T(20_000) }),
    );
    expect(plan.exchange).toMatchObject({ netDue: 0n, netRefund: 0n });
  });

  it("credit consumes the tender that cannot be paid back", () => {
    const s = snapshot(
      [line("a", 1000, T(30_000))],
      [
        { id: "g", method: "GIFT_CARD", amount: T(10_000) },
        { id: "c", method: "CASH", amount: T(20_000) },
      ],
    );
    const plan = mustPlan(s, [], req([{ id: "a", qty: 1000 }], { exchangeSaleTotal: T(10_000) }));
    expect(plan.payments).toEqual([
      { method: "CASH", amount: T(20_000), originalPaymentId: "c", crossMethod: false },
      { method: "EXCHANGE_CREDIT", amount: T(10_000), originalPaymentId: "g", crossMethod: false },
    ]);
  });

  it("an exchange needs a positive new total", () => {
    const r = planRefund(sale, [], req([{ id: "a", qty: 1000 }], { exchangeSaleTotal: 0n }), ctx());
    expect(r).toMatchObject({ ok: false, issues: [{ code: "EXCHANGE_INVALID" }] });
  });
});

describe("planRefund: policy and approvals", () => {
  const sale = snapshot(
    [line("a", 1000, T(10_000))],
    [{ id: "p", method: "CASH", amount: T(10_000) }],
    {
      occurredAt: new Date("2026-10-01T00:00:00Z"),
    },
  );

  it("no window by default", () => {
    expect(planRefund(sale, [], req([{ id: "a", qty: 1000 }]), ctx()).ok).toBe(true);
  });
  it("outside the window needs approval", () => {
    const policy = { maxRefundWindowDays: 7 };
    const noGrant = planRefund(
      sale,
      [],
      req([{ id: "a", qty: 1000 }]),
      ctx({ policy, grants: { refund: true, methodOverride: false, outsideWindow: false } }),
    );
    expect(noGrant.ok === false && noGrant.issues.map((i) => i.code)).toEqual([
      "REFUND_WINDOW_EXCEEDED",
      "APPROVAL_REQUIRED",
    ]);
    expect(planRefund(sale, [], req([{ id: "a", qty: 1000 }]), ctx({ policy })).ok).toBe(true);
    expect(
      planRefund(
        sale,
        [],
        req([{ id: "a", qty: 1000 }]),
        ctx({
          policy: { maxRefundWindowDays: 30 },
          grants: { refund: true, methodOverride: false, outsideWindow: false },
        }),
      ).ok,
    ).toBe(true);
  });
  it("a refund needs pos.refund or an approval", () => {
    const r = planRefund(
      sale,
      [],
      req([{ id: "a", qty: 1000 }]),
      ctx({ grants: { refund: false, methodOverride: false, outsideWindow: false } }),
    );
    expect(r).toMatchObject({
      ok: false,
      issues: [{ code: "APPROVAL_REQUIRED", details: { needs: ["refund"] } }],
    });
    expect(r.ok === false && r.preview?.totalAmount).toBe(T(10_000));
  });
});

// ---------------------------------------------------------------------------
// Random sales refunded in random pieces, in random order
// ---------------------------------------------------------------------------

function randomSale(r: () => number, roundingUnit: Money): RefundSaleSnapshot {
  const lineCount = int(r, 1, 4);
  const lines: RefundSaleLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    const weighed = r() < 0.4;
    const qtyMilli = weighed ? int(r, 1, 9000) : int(r, 1, 7) * 1000;
    const unitPrice = BigInt(int(r, 1, 900_000));
    const gross = extend(unitPrice, qtyMilli);
    const discount = r() < 0.4 ? BigInt(Math.floor(Number(gross) * r() * 0.6)) : 0n;
    const amount = gross - discount;
    const rule = {
      treatment: "STANDARD" as const,
      vatRateBps: 1000,
      cityTaxRateBps: r() < 0.3 ? 200 : 0,
      pricesIncludeTax: r() < 0.7,
    };
    const tax = computeLineTax(amount, rule);
    lines.push({
      id: `l${i}`,
      variantId: `v${i}`,
      unit: weighed ? "KG" : "PIECE",
      qtyMilli,
      totalAmount: tax.gross,
      netAmount: tax.net,
      vatAmount: tax.vat,
      cityTaxAmount: tax.cityTax,
      unitCost: BigInt(int(r, 0, 500_000)),
      pricesIncludeTax: rule.pricesIncludeTax,
    });
  }
  const items = sum(lines.map((l) => l.totalAmount));
  const tip = r() < 0.2 ? BigInt(int(r, 1, 50)) * 100n : 0n;
  const rounded = roundTotal(items + tip, roundingUnit);
  const payable = rounded.payable;
  // split payable into 1–3 supported tenders, cash in whole ₮
  const methods = ["CASH", "CARD", "QPAY", "BANK_TRANSFER"] as const;
  const payCount = int(r, 1, 3);
  const payments: RefundSaleSnapshot["payments"] = [];
  let left = payable;
  const cashUnit = roundingUnit < 100n ? roundingUnit : 100n;
  for (let i = 0; i < payCount; i++) {
    let method: (typeof methods)[number] = methods[int(r, 0, 3)]!;
    let amount = i === payCount - 1 ? left : BigInt(Math.floor(Number(left) * r()));
    if (method === "CASH") {
      if (i === payCount - 1 && amount % cashUnit !== 0n) method = "CARD";
      else amount -= amount % cashUnit;
    }
    if (amount <= 0n) continue;
    payments.push({ id: `p${i}`, method, amount });
    left -= amount;
  }
  if (left > 0n) payments.push({ id: "pz", method: "CARD", amount: left });
  return {
    id: "sale",
    status: "COMPLETED",
    occurredAt: new Date("2026-10-14T09:00:00Z"),
    shiftId: "s",
    totalAmount: payable,
    tipAmount: tip,
    roundingAmount: payable - items - tip,
    lines,
    payments,
  };
}

describe("seeded: random partial refunds can never over-refund and always reconcile", () => {
  it.each([1n, 100n, 500n, 1000n])("rounding unit %s", (roundingUnit) => {
    const r = rng(Number(roundingUnit) * 31 + 7);
    for (let n = 0; n < 300; n++) {
      const sale = randomSale(r, roundingUnit);
      const context = ctx({ roundingUnit, strategy: r() < 0.5 ? "PROPORTIONAL" : "LIFO" });
      let prev: PreviousRefund[] = [];
      let guard = 0;
      while (!isFullyRefunded(sale, prev) && guard++ < 40) {
        const progress = lineProgress(sale, prev).filter((p) => p.remainingQtyMilli > 0);
        const picked = progress.slice(0, int(r, 1, progress.length)).sort(() => r() - 0.5);
        const lines = picked.map((p) => {
          const piece = p.unit === "PIECE";
          const qty = piece
            ? int(r, 1, p.remainingQtyMilli / 1000) * 1000
            : r() < 0.3
              ? p.remainingQtyMilli
              : int(r, 1, p.remainingQtyMilli);
          return { id: p.saleLineId, qty, restock: r() < 0.7 };
        });
        const request = req(lines);
        const result = planRefund(sale, prev, request, context);
        if (!result.ok) throw new Error(`unexpected issues ${JSON.stringify(result.issues)}`);
        const plan = result.plan;
        expect(plan.netAmount + plan.vatAmount + plan.cityTaxAmount).toBe(plan.itemsTotal);
        expect(plan.itemsTotal + plan.tipAmount + plan.roundingAmount).toBe(plan.totalAmount);
        expect(sum(plan.payments.map((x) => x.amount))).toBe(plan.totalAmount);
        prev = [...prev, asPrevious(plan, `r${prev.length}`)];

        // invariants after every step
        const prog = lineProgress(sale, prev); // throws if any line is over-refunded
        expect(prog.every((p) => p.remaining.total >= 0n)).toBe(true);
        const caps = paymentCapacities(sale, prev); // throws if any tender is over-refunded
        expect(caps.every((c) => c.remaining >= 0n)).toBe(true);
        expect(sum(prev.map((x) => x.totalAmount)) <= sale.totalAmount).toBe(true);
        for (const p of plan.payments) {
          if (p.method === "CASH" && !p.crossMethod)
            expect(p.amount % (roundingUnit < 100n ? roundingUnit : 100n)).toBe(0n);
        }
      }
      expect(isFullyRefunded(sale, prev)).toBe(true);
      // everything reconciles exactly
      expect(sum(prev.map((x) => x.totalAmount))).toBe(sale.totalAmount);
      expect(sum(prev.map((x) => x.tipAmount))).toBe(sale.tipAmount);
      for (const l of sale.lines) {
        const rows = prev.flatMap((x) => x.lines.filter((y) => y.saleLineId === l.id));
        expect(sum(rows.map((y) => y.totalAmount))).toBe(l.totalAmount);
        expect(sum(rows.map((y) => y.netAmount))).toBe(l.netAmount);
        expect(sum(rows.map((y) => y.vatAmount))).toBe(l.vatAmount);
        expect(sum(rows.map((y) => y.cityTaxAmount))).toBe(l.cityTaxAmount);
        expect(rows.reduce((a, y) => a + y.qtyMilli, 0)).toBe(l.qtyMilli);
      }
      expect(paymentCapacities(sale, prev).every((c) => c.remaining === 0n)).toBe(true);
      // and nothing more can be refunded
      const extra = planRefund(sale, prev, req([{ id: sale.lines[0]!.id, qty: 1000 }]), context);
      expect(extra.ok).toBe(false);
    }
  });

  it("random exchanges keep credit + real refunds equal to the refund total", () => {
    const r = rng(555);
    for (let n = 0; n < 300; n++) {
      const sale = randomSale(r, 100n);
      const first = sale.lines[0]!;
      const qty = first.unit === "PIECE" ? 1000 : first.qtyMilli;
      const newTotal = BigInt(int(r, 1, 2_000_000)) * 100n;
      const result = planRefund(
        sale,
        [],
        req([{ id: first.id, qty }], { exchangeSaleTotal: newTotal }),
        ctx(),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      const { plan } = result;
      const credit = sum(
        plan.payments.filter((p) => p.method === "EXCHANGE_CREDIT").map((p) => p.amount),
      );
      const real = sum(
        plan.payments.filter((p) => p.method !== "EXCHANGE_CREDIT").map((p) => p.amount),
      );
      expect(credit).toBe(plan.exchange!.creditApplied);
      expect(real).toBe(plan.exchange!.netRefund);
      expect(credit + real).toBe(plan.totalAmount);
      expect(plan.exchange!.netDue + plan.exchange!.creditApplied).toBe(newTotal);
      // tenders are never over-consumed
      paymentCapacities(sale, [asPrevious(plan, "r")]);
    }
  });
});
