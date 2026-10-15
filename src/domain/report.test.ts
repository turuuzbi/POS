import { describe, expect, it } from "vitest";
import { extend } from "./qty";
import { fromMajor, sum, type Money } from "./money";
import {
  planRefund,
  type PaymentMethod,
  type PreviousRefund,
  type RefundPlan,
  type RefundSaleSnapshot,
} from "./refund";
import {
  buildXReport,
  buildZReport,
  checkReportInvariants,
  reportToJson,
  type ReportLineRow,
  type ReportRefundRow,
  type ReportSaleRow,
  type ShiftReportInput,
} from "./report";
import { roundTotal } from "./rounding";
import { computeLineTax } from "./tax";

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

const row = (
  gross: Money,
  opts: { qty?: number; unit?: "PIECE" | "KG"; vatBps?: number; cityBps?: number } = {},
): ReportLineRow => {
  const tax = computeLineTax(gross, {
    treatment: "STANDARD",
    vatRateBps: opts.vatBps ?? 1000,
    cityTaxRateBps: opts.cityBps ?? 0,
    pricesIncludeTax: true,
  });
  return {
    qtyMilli: opts.qty ?? 1000,
    unit: opts.unit ?? "PIECE",
    taxTreatment: "STANDARD",
    vatRateBps: opts.vatBps ?? 1000,
    cityTaxRateBps: opts.cityBps ?? 0,
    netAmount: tax.net,
    vatAmount: tax.vat,
    cityTaxAmount: tax.cityTax,
    totalAmount: tax.gross,
  };
};

let seq = 0;
function sale(
  lines: ReportLineRow[],
  payments: { method: PaymentMethod; amount: Money; change?: Money }[],
  extra: Partial<ReportSaleRow> = {},
): ReportSaleRow {
  seq++;
  const items = sum(lines.map((l) => l.totalAmount));
  return {
    id: `s${seq}`,
    number: `UB1-${String(seq).padStart(6, "0")}`,
    occurredAt: new Date(Date.UTC(2026, 9, 15, 9, seq)),
    void: null,
    itemsAmount: items,
    discountAmount: 0n,
    tipAmount: 0n,
    roundingAmount: 0n,
    totalAmount: items,
    lines,
    payments,
    ...extra,
  };
}

const base = (
  sales: ReportSaleRow[],
  refunds: ReportRefundRow[] = [],
  extra: Partial<ShiftReportInput> = {},
): ShiftReportInput => ({
  shift: {
    id: "shift",
    registerId: "reg",
    openedAt: new Date("2026-10-15T08:00:00Z"),
    openingFloat: T(50_000),
  },
  sales,
  refunds,
  cashMovements: [],
  asOf: new Date("2026-10-15T18:00:00Z"),
  ...extra,
});

describe("buildXReport", () => {
  it("empty shift", () => {
    const r = buildXReport(base([]));
    expect(r).toMatchObject({
      kind: "X",
      saleCount: 0,
      voidCount: 0,
      refundCount: 0,
      firstReceiptNumber: null,
      lastReceiptNumber: null,
      netSales: 0n,
      tendersTotal: 0n,
      tenders: [],
    });
    expect(r.cash.expected).toBe(T(50_000));
  });

  it("sales, tenders, tax by rate, receipt range and items", () => {
    const a = sale(
      [row(T(11_000), { qty: 2000 }), row(T(5500), { vatBps: 0 })],
      [
        { method: "CASH", amount: T(10_000), change: T(500) },
        { method: "CARD", amount: T(6500) },
      ],
    );
    const b = sale(
      [row(T(2200), { qty: 1250, unit: "KG" })],
      [{ method: "QPAY", amount: T(2200) }],
      {
        discountAmount: T(300),
        discounts: [{ source: "MANUAL", amount: T(300) }],
      },
    );
    const r = buildXReport(base([b, a]));
    expect(r.saleCount).toBe(2);
    expect(r.firstReceiptNumber).toBe(a.number);
    expect(r.lastReceiptNumber).toBe(b.number);
    expect(r.itemsSales).toBe(T(18_700));
    expect(r.discounts).toBe(T(300));
    expect(r.grossSales).toBe(T(19_000));
    expect(r.discountsBySource).toEqual([{ source: "MANUAL", amount: T(300) }]);
    expect(r.tenders.map((t) => [t.method, t.net])).toEqual([
      ["CASH", T(10_000)],
      ["CARD", T(6500)],
      ["QPAY", T(2200)],
    ]);
    expect(r.cash.changeGiven).toBe(T(500));
    expect(r.cash.expected).toBe(T(60_000));
    expect(r.taxByRate.map((x) => [x.vatRateBps, x.gross])).toEqual([
      [1000, T(13_200)],
      [0, T(5500)],
    ]);
    expect(r.items).toMatchObject({ lineCount: 3, pieceCount: 3, measuredLineCount: 1 });
    expect(checkReportInvariants(base([b, a]))).toEqual([]);
  });

  it("voided sales are listed, never counted", () => {
    const ok = sale([row(T(1000))], [{ method: "CASH", amount: T(1000) }]);
    const gone = sale([row(T(9000))], [{ method: "CASH", amount: T(9000) }], {
      void: { reason: "ENTRY_ERROR" },
    });
    const r = buildXReport(base([ok, gone]));
    expect(r.saleCount).toBe(1);
    expect(r.voidCount).toBe(1);
    expect(r.voids).toEqual([
      { saleId: gone.id, number: gone.number, reason: "ENTRY_ERROR", totalAmount: T(9000) },
    ]);
    expect(r.voidedTotal).toBe(T(9000));
    expect(r.salesTotal).toBe(T(1000));
    expect(r.tendersTotal).toBe(T(1000));
    expect(r.cash.cashSales).toBe(T(1000));
    expect(r.lastReceiptNumber).toBe(ok.number);
    expect(r.items.lineCount).toBe(1);
  });

  it("refunds reduce net sales, tax and the matching tender once", () => {
    const s = sale(
      [row(T(11_000))],
      [
        { method: "CASH", amount: T(5000) },
        { method: "CARD", amount: T(6000) },
      ],
    );
    const refundLine = row(T(5500));
    const refund: ReportRefundRow = {
      id: "r1",
      number: "UB1-R-000001",
      saleId: s.id,
      occurredAt: new Date("2026-10-15T10:00:00Z"),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: T(5500),
      lines: [refundLine],
      payments: [{ method: "CARD", amount: T(5500) }],
    };
    const input = base([s], [refund]);
    const r = buildXReport(input);
    expect(r.refunds.total).toBe(T(5500));
    expect(r.netSales).toBe(T(5500));
    expect(r.tenders).toEqual([
      { method: "CASH", sales: T(5000), refunds: 0n, net: T(5000) },
      { method: "CARD", sales: T(6000), refunds: T(5500), net: T(500) },
    ]);
    expect(r.tax.vat).toBe(s.lines[0]!.vatAmount - refundLine.vatAmount);
    expect(r.items.refundedPieceCount).toBe(1);
    expect(checkReportInvariants(input)).toEqual([]);
  });

  it("cash refunds and movements feed expected cash; a refund of an earlier shift's sale counts here", () => {
    const refund: ReportRefundRow = {
      id: "r1",
      number: "UB1-R-000002",
      saleId: "older-sale",
      occurredAt: new Date("2026-10-15T10:00:00Z"),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: T(3000),
      lines: [row(T(3000))],
      payments: [{ method: "CASH", amount: T(3000) }],
    };
    const r = buildXReport(
      base([], [refund], {
        cashMovements: [
          { type: "CASH_IN", amount: T(1000) },
          { type: "CASH_OUT", amount: T(4000) },
        ],
      }),
    );
    expect(r.cash).toMatchObject({ cashRefunds: T(3000), cashIn: T(1000), cashOut: T(4000) });
    expect(r.cash.expected).toBe(T(50_000) - T(3000) + T(1000) - T(4000));
    expect(r.netSales).toBe(-T(3000));
    expect(r.tendersTotal).toBe(-T(3000));
  });

  it("exchange credit nets to zero between the refund and the exchange sale", () => {
    const original = sale([row(T(10_000))], [{ method: "CARD", amount: T(10_000) }]);
    const exchange = sale(
      [row(T(12_000))],
      [
        { method: "EXCHANGE_CREDIT", amount: T(10_000) },
        { method: "CASH", amount: T(2000) },
      ],
    );
    const refund: ReportRefundRow = {
      id: "r1",
      number: "UB1-R-000003",
      saleId: original.id,
      occurredAt: new Date("2026-10-15T11:00:00Z"),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: T(10_000),
      lines: [row(T(10_000))],
      payments: [{ method: "EXCHANGE_CREDIT", amount: T(10_000) }],
    };
    const input = base([original, exchange], [refund]);
    const r = buildXReport(input);
    expect(r.tenders.find((t) => t.method === "EXCHANGE_CREDIT")!.net).toBe(0n);
    expect(r.netSales).toBe(T(12_000));
    expect(r.tendersTotal).toBe(T(12_000));
    expect(checkReportInvariants(input)).toEqual([]);
  });

  it("rejects duplicate rows (no double counting)", () => {
    const s = sale([row(T(1000))], [{ method: "CASH", amount: T(1000) }]);
    expect(() => buildXReport(base([s, s]))).toThrow(/duplicate sale/);
    const refund: ReportRefundRow = {
      id: "r",
      number: "R",
      saleId: s.id,
      occurredAt: new Date(),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: 1n,
      lines: [],
      payments: [{ method: "CASH", amount: 1n }],
    };
    expect(() => buildXReport(base([s], [refund, refund]))).toThrow(/duplicate refund/);
  });

  it("invariant checker flags a refund against a voided sale and unbalanced payments", () => {
    const gone = sale([row(T(1000))], [{ method: "CASH", amount: T(1000) }], {
      void: { reason: "OTHER", note: "x" },
    });
    const refund: ReportRefundRow = {
      id: "r",
      number: "R1",
      saleId: gone.id,
      occurredAt: new Date(),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: T(500),
      lines: [row(T(500))],
      payments: [{ method: "CASH", amount: T(500) }],
    };
    expect(checkReportInvariants(base([gone], [refund]))).toEqual([
      "refund R1: against a voided sale",
    ]);
    const bad = sale([row(T(1000))], [{ method: "CASH", amount: T(900) }]);
    expect(checkReportInvariants(base([bad])).length).toBeGreaterThan(0);
  });
});

describe("buildZReport", () => {
  it("adds counted cash, variance and denominations, and serialises to JSON", () => {
    const s = sale([row(T(10_000))], [{ method: "CASH", amount: T(10_000) }]);
    const z = buildZReport(base([s]), {
      closedAt: new Date("2026-10-15T20:00:00Z"),
      countedCash: T(59_500),
      denominations: { "20000": 2, "10000": 1, "5000": 1, "500": 9 },
      note: "short 500",
    });
    expect(z.kind).toBe("Z");
    expect(z.closing).toMatchObject({
      countedCash: T(59_500),
      cashVariance: -T(500),
      classification: "SHORT",
      note: "short 500",
    });
    const json = JSON.stringify(reportToJson(z));
    const back = JSON.parse(json) as { cash: { expected: string }; closing: { closedAt: string } };
    expect(back.cash.expected).toBe(String(T(60_000)));
    expect(back.closing.closedAt).toBe("2026-10-15T20:00:00.000Z");
    // deterministic
    expect(
      JSON.stringify(
        reportToJson(
          buildZReport(base([s]), {
            closedAt: new Date("2026-10-15T20:00:00Z"),
            countedCash: T(59_500),
            denominations: { "20000": 2, "10000": 1, "5000": 1, "500": 9 },
            note: "short 500",
          }),
        ),
      ),
    ).toBe(json);
  });
});

// ---------------------------------------------------------------------------
// Seeded: shifts built from real refund plans must satisfy every invariant
// ---------------------------------------------------------------------------

function randomShift(r: () => number) {
  const sales: ReportSaleRow[] = [];
  const refunds: ReportRefundRow[] = [];
  const count = int(r, 1, 6);
  const unit = [1n, 100n, 500n][int(r, 0, 2)]!;
  for (let i = 0; i < count; i++) {
    const lineCount = int(r, 1, 3);
    const lines: (ReportLineRow & { id: string; unitCost: Money })[] = [];
    for (let j = 0; j < lineCount; j++) {
      const weighed = r() < 0.3;
      const qty = weighed ? int(r, 1, 5000) : int(r, 1, 5) * 1000;
      const gross = extend(BigInt(int(r, 100, 500_000)), qty);
      const l = row(gross, {
        qty,
        unit: weighed ? "KG" : "PIECE",
        vatBps: r() < 0.8 ? 1000 : 0,
        cityBps: r() < 0.3 ? 200 : 0,
      });
      lines.push({ ...l, id: `l${j}`, unitCost: 0n });
    }
    const items = sum(lines.map((l) => l.totalAmount));
    const rounded = roundTotal(items, unit);
    const methods = ["CASH", "CARD", "QPAY"] as const;
    const cashUnit = unit < 100n ? unit : 100n;
    const payments: ReportSaleRow["payments"] = [];
    let left = rounded.payable;
    const first = methods[int(r, 0, 2)]!;
    let amount = r() < 0.5 ? left : BigInt(Math.floor(Number(left) * r()));
    let method: PaymentMethod = first;
    if (method === "CASH" && amount % cashUnit !== 0n) amount -= amount % cashUnit;
    if (amount > 0n) {
      payments.push({ method, amount });
      left -= amount;
    }
    if (left > 0n) {
      method = "CARD";
      payments.push({ method, amount: left });
    }
    const row0 = sale(lines, payments, {
      itemsAmount: items,
      roundingAmount: rounded.roundingAmount,
      totalAmount: rounded.payable,
      void: r() < 0.15 ? { reason: "CUSTOMER_CANCELLED" } : null,
    });
    sales.push(row0);

    if (row0.void === null && r() < 0.6) {
      const snap: RefundSaleSnapshot = {
        id: row0.id,
        status: "COMPLETED",
        occurredAt: row0.occurredAt,
        shiftId: "shift",
        totalAmount: row0.totalAmount,
        tipAmount: 0n,
        roundingAmount: row0.roundingAmount,
        lines: lines.map((l) => ({
          id: l.id,
          variantId: l.id,
          unit: l.unit,
          qtyMilli: l.qtyMilli,
          totalAmount: l.totalAmount,
          netAmount: l.netAmount,
          vatAmount: l.vatAmount,
          cityTaxAmount: l.cityTaxAmount,
          unitCost: 0n,
        })),
        payments: payments.map((p, k) => ({ id: `p${k}`, method: p.method, amount: p.amount })),
      };
      let prev: PreviousRefund[] = [];
      const rounds = int(r, 1, 3);
      for (let k = 0; k < rounds; k++) {
        const open = snap.lines.filter(
          (l) =>
            l.qtyMilli -
              prev
                .flatMap((p) => p.lines)
                .filter((x) => x.saleLineId === l.id)
                .reduce((a, x) => a + x.qtyMilli, 0) >
            0,
        );
        if (open.length === 0) break;
        const target = open[int(r, 0, open.length - 1)]!;
        const done = prev
          .flatMap((p) => p.lines)
          .filter((x) => x.saleLineId === target.id)
          .reduce((a, x) => a + x.qtyMilli, 0);
        const remaining = target.qtyMilli - done;
        const qty =
          target.unit === "PIECE" ? int(r, 1, remaining / 1000) * 1000 : int(r, 1, remaining);
        const res = planRefund(
          snap,
          prev,
          {
            lines: [{ saleLineId: target.id, qtyMilli: qty, restock: true }],
            reason: "CHANGED_MIND",
          },
          {
            shiftOpen: true,
            now: new Date("2026-10-15T12:00:00Z"),
            roundingUnit: unit,
            grants: { refund: true, methodOverride: true, outsideWindow: true },
          },
        );
        if (!res.ok) throw new Error(JSON.stringify(res.issues));
        const plan: RefundPlan = res.plan;
        prev = [
          ...prev,
          {
            id: `r${k}`,
            totalAmount: plan.totalAmount,
            tipAmount: plan.tipAmount,
            lines: plan.lines.map((l) => ({ ...l, saleLineId: l.saleLineId })),
            payments: plan.payments.map((p) => ({
              method: p.method,
              amount: p.amount,
              originalPaymentId: p.originalPaymentId,
            })),
          },
        ];
        refunds.push({
          id: `${row0.id}-r${k}`,
          number: `${row0.number}-R${k}`,
          saleId: row0.id,
          occurredAt: new Date(row0.occurredAt.getTime() + 60_000),
          tipAmount: plan.tipAmount,
          roundingAmount: plan.roundingAmount,
          totalAmount: plan.totalAmount,
          lines: plan.lines.map((pl) => {
            const src = lines.find((l) => l.id === pl.saleLineId)!;
            return {
              qtyMilli: pl.qtyMilli,
              unit: src.unit,
              taxTreatment: src.taxTreatment,
              vatRateBps: src.vatRateBps,
              cityTaxRateBps: src.cityTaxRateBps,
              netAmount: pl.netAmount,
              vatAmount: pl.vatAmount,
              cityTaxAmount: pl.cityTaxAmount,
              totalAmount: pl.totalAmount,
            };
          }),
          payments: plan.payments.map((p) => ({ method: p.method, amount: p.amount })),
        });
      }
    }
  }
  return base(sales, refunds, {
    cashMovements: [
      { type: "CASH_IN", amount: BigInt(int(r, 0, 100)) * 100n },
      { type: "CASH_OUT", amount: BigInt(int(r, 0, 100)) * 100n },
    ],
  });
}

describe("seeded invariants", () => {
  it("tenders = net takings, tax rows reconcile, voids excluded, refunds counted once", () => {
    const r = rng(31337);
    for (let n = 0; n < 300; n++) {
      const input = randomShift(r);
      const report = buildXReport(input);
      expect(checkReportInvariants(input, report)).toEqual([]);
      expect(report.tendersTotal).toBe(report.netSales);
      expect(report.netSales).toBe(
        sum(input.sales.filter((s) => s.void === null).map((s) => s.totalAmount)) -
          sum(input.refunds.map((x) => x.totalAmount)),
      );
      expect(report.saleCount + report.voidCount).toBe(input.sales.length);
      expect(report.refundCount).toBe(input.refunds.length);
      // order of rows does not matter
      const shuffled = {
        ...input,
        sales: [...input.sales].reverse(),
        refunds: [...input.refunds].reverse(),
      };
      expect(JSON.stringify(reportToJson(buildXReport(shuffled)))).toBe(
        JSON.stringify(reportToJson(report)),
      );
    }
  });
});
